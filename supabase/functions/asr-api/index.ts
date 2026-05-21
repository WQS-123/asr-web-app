import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

type AnyRecord = Record<string, any>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SECRET_KEYS = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  JSON.parse(SUPABASE_SECRET_KEYS).default ||
  "";
const DASH_SCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") || "";
const DASH_SCOPE_BASE_URL = (Deno.env.get("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
const AI_DEFAULT_BASE_URL = (Deno.env.get("AI_BASE_URL") || "https://api.deepseek.com").replace(/\/$/, "");
const AI_DEFAULT_MODEL = Deno.env.get("AI_MODEL") || "deepseek-chat";
const PUBLIC_PASSWORD = Deno.env.get("PUBLIC_PASSWORD") || "";
const AUTH_COOKIE_NAME = "asr_public_auth";
const AUTH_TOKEN = Deno.env.get("PUBLIC_AUTH_TOKEN") || crypto.randomUUID();
const AUDIO_BUCKET = "audio-uploads";
const STATE_ID = "default";
const MAX_BASE64_BYTES = Number(Deno.env.get("ASR_MAX_BASE64_BYTES") || 7 * 1024 * 1024);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const defaultState = (): AnyRecord => ({
  selectedTopicId: "topic-default",
  selectedDocId: "",
  expandedTopicIds: ["topic-default"],
  topics: [
    {
      id: "topic-default",
      name: "Default topic",
      context: "",
      glossary: {},
    },
  ],
  docs: [],
  targetDocument: "",
  suggestions: [],
});

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });

const parseCookie = (request: Request) => {
  const cookie = request.headers.get("cookie") || "";
  return Object.fromEntries(
    cookie.split(";").map((part) => {
      const [key, ...value] = part.trim().split("=");
      return [key, value.join("=")];
    }).filter(([key]) => key),
  );
};

const requireAuth = (request: Request) => {
  if (!PUBLIC_PASSWORD) return null;
  const cookies = parseCookie(request);
  if (cookies[AUTH_COOKIE_NAME] === AUTH_TOKEN) return null;
  return json({ error: "需要访问密码。" }, 401);
};

const readState = async () => {
  const { data, error } = await supabase.from("app_state").select("state").eq("id", STATE_ID).maybeSingle();
  if (error) throw error;
  if (data?.state) return withSignedAudioUrls(data.state as AnyRecord);
  const state = defaultState();
  await writeState(state);
  return withSignedAudioUrls(state);
};

const writeState = async (state: AnyRecord) => {
  const { error } = await supabase.from("app_state").upsert({ id: STATE_ID, state });
  if (error) throw error;
  return state;
};

const readJob = async (id: string) => {
  const { data, error } = await supabase.from("asr_jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    docId: data.doc_id,
    status: data.status,
    stage: data.stage,
    asrError: data.error,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    ...(data.payload || {}),
  };
};

const writeJob = async (job: AnyRecord) => {
  const { error } = await supabase.from("asr_jobs").upsert({
    id: job.id,
    doc_id: job.docId || "",
    status: job.status || "running",
    stage: job.stage || "",
    error: job.asrError || "",
    payload: job,
  });
  if (error) throw error;
  return job;
};

const withSignedAudioUrls = async (state: AnyRecord) => {
  const docs = state.docs || [];
  await Promise.all(docs.map(async (doc: AnyRecord) => {
    if (!doc.storagePath) return;
    const { data } = await supabase.storage.from(AUDIO_BUCKET).createSignedUrl(doc.storagePath, 3600);
    if (data?.signedUrl) doc.audioUrl = data.signedUrl;
  }));
  return state;
};

const findTopic = (state: AnyRecord, id: string) => (state.topics || []).find((topic: AnyRecord) => topic.id === id);
const findDoc = (state: AnyRecord, id: string) => (state.docs || []).find((doc: AnyRecord) => doc.id === id);

const stripFillers = (text: string) => text
  .replace(/[，。；、\s]*(嗯+|呃+|额+|啊+|哦+|哈)[，。；、\s]*/g, "，")
  .replace(/，{2,}/g, "，")
  .replace(/^[，\s]+|[，\s]+$/g, "");

const applyGlossary = (text: string, topic: AnyRecord) => {
  let output = stripFillers(text);
  for (const [source, target] of Object.entries(topic.glossary || {})) {
    output = output.replaceAll(source, String(target));
  }
  return output;
};

const cleanedSegments = (segments: AnyRecord[], topic: AnyRecord) => segments.map((segment) => ({
  ...segment,
  text: applyGlossary(String(segment.text || ""), topic),
}));

const polishFromSegments = (segments: AnyRecord[], topic: AnyRecord = { name: "", glossary: {} }) => {
  const corrected = cleanedSegments(segments, topic).map((segment) => String(segment.text || "").trim()).filter(Boolean);
  return corrected.join("\n\n");
};

const docReadyForCalibration = (doc: AnyRecord) => {
  const status = String(doc?.asrStatus || "").toLowerCase();
  return Boolean(doc?.segments?.length) && !["ready", "running", "paused", "error", "canceled"].includes(status);
};

const buildDoc = (fileName: string, topic: AnyRecord, audioUrl: string, durationSeconds = 0, title = "") => ({
  id: `doc-${crypto.randomUUID().slice(0, 12)}`,
  topicId: topic.id,
  title: title.trim() || fileName.replace(/\.[^.]+$/, "") || "untitled-audio",
  createdAt: new Date().toISOString(),
  audioName: fileName,
  audioUrl,
  storagePath: audioUrl,
  durationSeconds,
  segments: [],
  finalText: "",
  asrStatus: "ready",
  asrError: "",
});

const textToTimedSegments = (text: string, durationSeconds: number, segmentSeconds: number) => {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (!segmentSeconds || !durationSeconds || durationSeconds <= segmentSeconds) {
    return [{ start: 0, end: Math.max(1, durationSeconds || segmentSeconds || 1), text: cleaned }];
  }
  const count = Math.max(1, Math.ceil(durationSeconds / segmentSeconds));
  const target = Math.max(1, Math.ceil(cleaned.length / count));
  const parts: string[] = [];
  let remaining = cleaned;
  while (remaining && parts.length < count - 1) {
    let cut = Math.min(remaining.length, target);
    while (cut < remaining.length && !"，,。！？.!? ".includes(remaining[cut])) cut += 1;
    parts.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.map((part, index) => ({
    start: index * segmentSeconds,
    end: Math.min(durationSeconds, (index + 1) * segmentSeconds),
    text: part,
  }));
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const transcribeAudio = async (audioBytes: Uint8Array, mimeType: string, durationSeconds: number, segmentSeconds: number) => {
  if (!DASH_SCOPE_API_KEY) throw new Error("缺少 DASHSCOPE_API_KEY。");
  if (audioBytes.byteLength > MAX_BASE64_BYTES) {
    throw new Error("当前 Supabase 直传模式只支持较小音频。请上传更短音频，或改用 Storage signed URL + DashScope 异步任务。");
  }
  const dataUrl = `data:${mimeType || "audio/mpeg"};base64,${bytesToBase64(audioBytes)}`;
  const response = await fetch(`${DASH_SCOPE_BASE_URL}/compatible-mode/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${DASH_SCOPE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "qwen3-asr-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: dataUrl } }],
        },
      ],
      stream: false,
      asr_options: { enable_itn: true },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || JSON.stringify(payload).slice(0, 500));
  const text = payload?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error("DashScope 没有返回转录文本。");
  return textToTimedSegments(text, durationSeconds, segmentSeconds);
};

const extractJsonObject = (text: string) => {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("AI 服务返回的内容不是有效 JSON。");
  }
};

const aiSettingsFromPayload = (payload: AnyRecord) => ({
  apiKey: String(payload.apiKey || Deno.env.get("DEEPSEEK_API_KEY") || Deno.env.get("AI_API_KEY") || "").trim(),
  baseUrl: String(payload.baseUrl || AI_DEFAULT_BASE_URL).trim().replace(/\/$/, ""),
  model: String(payload.model || AI_DEFAULT_MODEL).trim(),
});

const aiChatJson = async (
  settings: { apiKey: string; baseUrl: string; model: string },
  systemPrompt: string,
  userPayload: AnyRecord,
) => {
  if (!settings.apiKey) throw new Error("缺少 AI API Key。");
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || JSON.stringify(payload).slice(0, 600));
  const content = payload?.choices?.[0]?.message?.content || "";
  if (!content) throw new Error("AI 服务没有返回可用内容。");
  return extractJsonObject(content);
};

const normalizeAiSegments = (inputSegments: AnyRecord[], aiSegments: unknown, topic: AnyRecord) => {
  if (!Array.isArray(aiSegments) || aiSegments.length !== inputSegments.length) return cleanedSegments(inputSegments, topic);
  return inputSegments.map((source, index) => ({
    start: source.start || 0,
    end: source.end || 0,
    text: String((aiSegments[index] as AnyRecord)?.text || "").trim() || applyGlossary(String(source.text || ""), topic),
  }));
};

const contextPrompt = [
  "你是中文语音转录校准助手。任务：在不添加事实、不扩写内容、不改变说话人原意的前提下，校准 ASR 每句话。",
  "删除明显口头语和语气词，修正同音词、英文/中文夹杂术语、大小写、符号和专有名词。",
  "如果用户提供了 folder context，你必须优先依据其中的背景、专业词、缩写、固定译法校准；如果 context 为空，只做基础清理和明显错字修正。",
  "返回严格 JSON：{\"segments\":[{\"start\":数字,\"end\":数字,\"text\":\"校准后的句子\"}],\"finalText\":\"可直接编辑的完整文档\"}。segments 数量和时间戳必须与输入一致。",
].join("");

const filePrompt = [
  "你是根据历史人工校对稿进行 ASR 后校准的助手。参考同一文件夹中已校对文档的写法、术语、格式和表达偏好，对当前语音转录结果做校准。",
  "只修正转录错误、术语、口头语和表达顺序；不得把参考文档中的新事实强行加入当前内容。",
  "返回严格 JSON：{\"segments\":[{\"start\":数字,\"end\":数字,\"text\":\"校准后的句子\"}],\"finalText\":\"可直接改写的完整文档\"}。segments 数量和时间戳必须与输入一致。",
].join("");

const calibrateWithContext = async (doc: AnyRecord, topic: AnyRecord, payload: AnyRecord) => {
  const result = await aiChatJson(aiSettingsFromPayload(payload), contextPrompt, {
    folderName: topic.name || "",
    folderContext: topic.context || "",
    glossary: topic.glossary || {},
    segments: doc.segments || [],
  });
  const segments = normalizeAiSegments(doc.segments || [], result.segments, topic);
  return { segments, finalText: String(result.finalText || "").trim() || polishFromSegments(segments, topic) };
};

const calibrateWithFiles = async (doc: AnyRecord, topic: AnyRecord, docs: AnyRecord[], payload: AnyRecord) => {
  const references = docs
    .filter((item) => item.id !== doc.id && item.topicId === topic.id && item.finalText)
    .slice(0, 8)
    .map((item) => ({ title: item.title || "", finalText: String(item.finalText || "").slice(0, 5000) }));
  if (!references.length) throw new Error("当前文件夹里还没有其他已校对文档可作为 file 校准参考。");
  const result = await aiChatJson(aiSettingsFromPayload(payload), filePrompt, {
    folderName: topic.name || "",
    folderContext: topic.context || "",
    glossary: topic.glossary || {},
    referenceDocuments: references,
    currentSegments: doc.segments || [],
  });
  const segments = normalizeAiSegments(doc.segments || [], result.segments, topic);
  return { segments, finalText: String(result.finalText || "").trim() || polishFromSegments(segments, topic) };
};

const makeSuggestions = (target: string, doc: AnyRecord, topic: AnyRecord) => {
  const suggestions: AnyRecord[] = [];
  for (const [source, replacement] of Object.entries(topic.glossary || {})) {
    if (target.includes(source)) {
      suggestions.push({
        original: source,
        replacement: String(replacement),
        reason: `参考「${doc.title || "当前文档"}」的校正文档，术语统一为 ${replacement}。`,
      });
    }
  }
  const sentences = target.split(/(?<=[。！？.!?])\s*/).map((item) => item.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (sentence.includes("蛋白合成缺陷")) {
      suggestions.push({
        original: sentence,
        replacement: applyGlossary(sentence, topic).replace("蛋白合成缺陷", "影响蛋白成熟或正常形成的机制问题"),
        reason: "当前校正文档强调不要把机制简单写成蛋白合成缺陷，需要保留原意并说清楚机制。",
      });
    }
    if (sentence.includes("调节蛋白量") || sentence.includes("调节器")) {
      suggestions.push({
        original: sentence,
        replacement: applyGlossary(sentence, topic).replace("调节蛋白量", "改善蛋白功能或成熟状态"),
        reason: "当前校正文档里 modulator 的表达更接近作用机制，不建议只写成调节蛋白量。",
      });
    }
  }
  return suggestions;
};

const handleAuth = async (request: Request) => {
  if (!PUBLIC_PASSWORD) return json({ ok: true, authRequired: false });
  const payload = await request.json().catch(() => ({}));
  if (payload.password === PUBLIC_PASSWORD) {
    return json(
      { ok: true, authRequired: true },
      200,
      { "set-cookie": `${AUTH_COOKIE_NAME}=${AUTH_TOKEN}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure` },
    );
  }
  return json({ error: "访问密码不正确。" }, 401);
};

const handleRequest = async (request: Request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/functions\/v1\/asr-api/, "") || "/";
  if (path !== "/api/auth") {
    const authError = requireAuth(request);
    if (authError) return authError;
  }

  if (request.method === "POST" && path === "/api/auth") return handleAuth(request);
  if (request.method === "GET" && path === "/api/state") return json(await readState());
  if (request.method === "PUT" && path === "/api/state") return json(await writeState(await request.json()));
  if (request.method === "GET" && path === "/api/voice-memos") return json({ items: [], disabled: true });

  if (request.method === "POST" && path === "/api/topics") {
    const state = await readState();
    const payload = await request.json();
    const topic = { id: `topic-${crypto.randomUUID().slice(0, 12)}`, name: payload.name || "Untitled", context: payload.context || "", glossary: payload.glossary || {} };
    state.topics.unshift(topic);
    state.selectedTopicId = topic.id;
    state.selectedDocId = "";
    state.expandedTopicIds = [...new Set([...(state.expandedTopicIds || []), topic.id])];
    return json(await writeState(state), 201);
  }

  const topicMatch = path.match(/^\/api\/topics\/([^/]+)$/);
  if (topicMatch) {
    const state = await readState();
    const topic = findTopic(state, decodeURIComponent(topicMatch[1]));
    if (!topic) return json({ error: "Topic not found" }, 404);
    if (request.method === "PUT") Object.assign(topic, await request.json());
    if (request.method === "DELETE") {
      state.docs = state.docs.filter((doc: AnyRecord) => doc.topicId !== topic.id);
      state.topics = state.topics.filter((item: AnyRecord) => item.id !== topic.id);
      if (state.selectedTopicId === topic.id) state.selectedTopicId = state.topics[0]?.id || "";
    }
    return json(await writeState(state));
  }

  const docMatch = path.match(/^\/api\/docs\/([^/]+)$/);
  if (docMatch) {
    const state = await readState();
    const doc = findDoc(state, decodeURIComponent(docMatch[1]));
    if (!doc) return json({ error: "Document not found" }, 404);
    if (request.method === "PUT") Object.assign(doc, await request.json());
    if (request.method === "DELETE") {
      state.docs = state.docs.filter((item: AnyRecord) => item.id !== doc.id);
      if (state.selectedDocId === doc.id) state.selectedDocId = "";
    }
    return json(await writeState(state));
  }

  if (request.method === "POST" && path === "/api/audio/import") {
    const state = await readState();
    const form = await request.formData();
    const topic = findTopic(state, String(form.get("topicId") || ""));
    const file = form.get("audio");
    if (!topic || !(file instanceof File)) return json({ error: "Missing topic or audio file" }, 400);
    const storagePath = `${topic.id}/${crypto.randomUUID()}-${file.name}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error } = await supabase.storage.from(AUDIO_BUCKET).upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (error) throw error;
    const durationSeconds = Number(form.get("durationSeconds") || 0);
    const doc = buildDoc(file.name, topic, storagePath, durationSeconds, String(form.get("displayName") || ""));
    const signed = await supabase.storage.from(AUDIO_BUCKET).createSignedUrl(storagePath, 3600);
    doc.audioUrl = signed.data?.signedUrl || "";
    state.docs.unshift(doc);
    state.selectedTopicId = topic.id;
    state.selectedDocId = doc.id;
    state.expandedTopicIds = [...new Set([...(state.expandedTopicIds || []), topic.id])];
    await writeState(state);
    return json({ state, doc }, 201);
  }

  if (request.method === "POST" && path === "/api/realtime/start") {
    const state = await readState();
    const form = await request.formData();
    const doc = findDoc(state, String(form.get("docId") || ""));
    if (!doc) return json({ error: "Document not found" }, 404);
    const storagePath = doc.storagePath || doc.audioUrl;
    const downloaded = await supabase.storage.from(AUDIO_BUCKET).download(storagePath);
    if (downloaded.error || !downloaded.data) throw downloaded.error || new Error("Audio download failed");
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    doc.asrStatus = "running";
    doc.asrError = "";
    doc.segments = [];
    await writeState(state);
    const jobId = `rt-${crypto.randomUUID().slice(0, 12)}`;
    const baseJob = {
      id: jobId,
      status: "running",
      stage: "dashscope_sync",
      docId: doc.id,
      topicId: doc.topicId,
      segmentSeconds: Number(form.get("segmentSeconds") || 30),
      durationSeconds: Number(form.get("durationSeconds") || doc.durationSeconds || 0),
      completedSegments: [],
      plannedSegments: [{ start: 0, end: doc.durationSeconds || 0 }],
      asrProvider: "dashscope",
      asrError: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJob(baseJob);
    try {
      const segments = await transcribeAudio(bytes, downloaded.data.type, Number(form.get("durationSeconds") || doc.durationSeconds || 0), Number(form.get("segmentSeconds") || 30));
      doc.segments = segments;
      doc.finalText = polishFromSegments(segments, findTopic(state, doc.topicId) || {});
      doc.asrStatus = "realtime";
      doc.asrProvider = "dashscope";
      await writeState(state);
      const doneJob = {
        ...baseJob,
        status: "done",
        stage: "done",
        completedSegments: segments,
        updatedAt: new Date().toISOString(),
      };
      await writeJob(doneJob);
      return json(doneJob, 201);
    } catch (error) {
      doc.asrStatus = "error";
      doc.asrError = error instanceof Error ? error.message : String(error);
      await writeState(state);
      const errorJob = {
        ...baseJob,
        status: "error",
        asrError: doc.asrError,
        completedSegments: [],
        updatedAt: new Date().toISOString(),
      };
      await writeJob(errorJob);
      return json(errorJob, 201);
    }
  }

  if (request.method === "GET" && path === "/api/realtime") {
    const jobId = url.searchParams.get("jobId") || "";
    const job = jobId ? await readJob(jobId) : null;
    if (!job) return json({ error: "Realtime job not found" }, 404);
    return json(job);
  }

  if (request.method === "POST" && ["/api/realtime/pause", "/api/realtime/resume", "/api/realtime/cancel"].includes(path)) {
    const payload = await request.json().catch(() => ({}));
    const job = await readJob(String(payload.jobId || ""));
    if (!job) return json({ error: "Realtime job not found" }, 404);

    if (path.endsWith("/pause") && job.status === "running") {
      job.status = "paused";
      job.stage = "paused";
    }
    if (path.endsWith("/resume") && job.status === "paused") {
      job.status = "running";
      job.stage = "dashscope_sync";
    }
    if (path.endsWith("/cancel")) {
      job.status = "canceled";
      job.stage = "canceled";
      const state = await readState();
      const doc = findDoc(state, job.docId || "");
      if (doc) {
        doc.asrStatus = "ready";
        doc.asrError = "";
        await writeState(state);
      }
    }
    job.updatedAt = new Date().toISOString();
    return json(await writeJob(job));
  }

  const calibrationMatch = path.match(/^\/api\/calibrate\/(context|file)$/);
  if (request.method === "POST" && calibrationMatch) {
    const payload = await request.json().catch(() => ({}));
    const state = await readState();
    const doc = findDoc(state, String(payload.docId || ""));
    if (!doc) return json({ error: "Document not found" }, 400);
    const topic = findTopic(state, doc.topicId);
    if (!topic) return json({ error: "Topic not found" }, 400);
    if (!docReadyForCalibration(doc)) return json({ error: "语音转录完成后才可以校准。" }, 409);
    const calibrated = calibrationMatch[1] === "context"
      ? await calibrateWithContext(doc, topic, payload)
      : await calibrateWithFiles(doc, topic, state.docs || [], payload);
    doc.segments = calibrated.segments;
    doc.finalText = calibrated.finalText;
    doc.calibrationMode = calibrationMatch[1];
    doc.calibratedAt = new Date().toISOString();
    await writeState(state);
    return json({ state, doc });
  }

  if (request.method === "POST" && path === "/api/suggestions") {
    const state = await readState();
    const payload = await request.json().catch(() => ({}));
    const doc = findDoc(state, String(payload.docId || ""));
    if (!doc) return json({ error: "Document not found" }, 400);
    const topic = findTopic(state, doc.topicId);
    if (!topic) return json({ error: "Topic not found" }, 400);
    state.targetDocument = payload.targetDocument || "";
    state.suggestions = makeSuggestions(state.targetDocument, doc, topic);
    return json(await writeState(state));
  }

  if (request.method === "POST" && path === "/api/transcribe") {
    const state = await readState();
    const form = await request.formData();
    const topic = findTopic(state, String(form.get("topicId") || ""));
    const file = form.get("audio");
    if (!topic || !(file instanceof File)) return json({ error: "Missing topic or audio file" }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const durationSeconds = Number(form.get("durationSeconds") || 0);
    const segments = await transcribeAudio(bytes, file.type, durationSeconds, 30);
    const doc = buildDoc(file.name, topic, "", durationSeconds);
    doc.segments = segments;
    doc.finalText = polishFromSegments(segments, topic);
    doc.asrStatus = "real";
    doc.asrProvider = "dashscope";
    state.docs.unshift(doc);
    state.selectedTopicId = topic.id;
    state.selectedDocId = doc.id;
    state.suggestions = [];
    return json(await writeState(state), 201);
  }

  return json({ error: `Route not implemented: ${request.method} ${path}` }, 404);
};

Deno.serve(async (request) => {
  try {
    return await handleRequest(request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
