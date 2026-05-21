import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

type AnyRecord = Record<string, any>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const DASH_SCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") || "";
const DASH_SCOPE_BASE_URL = (Deno.env.get("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
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

const polishFromSegments = (segments: AnyRecord[]) => segments.map((segment) => String(segment.text || "").trim()).filter(Boolean).join("\n\n");

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

const transcribeAudio = async (audioBytes: Uint8Array, mimeType: string, durationSeconds: number, segmentSeconds: number) => {
  if (!DASH_SCOPE_API_KEY) throw new Error("缺少 DASHSCOPE_API_KEY。");
  if (audioBytes.byteLength > MAX_BASE64_BYTES) {
    throw new Error("当前 Supabase 直传模式只支持较小音频。请上传更短音频，或改用 Storage signed URL + DashScope 异步任务。");
  }
  const binary = Array.from(audioBytes, (byte) => String.fromCharCode(byte)).join("");
  const dataUrl = `data:${mimeType || "audio/mpeg"};base64,${btoa(binary)}`;
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
    try {
      const segments = await transcribeAudio(bytes, downloaded.data.type, Number(form.get("durationSeconds") || doc.durationSeconds || 0), Number(form.get("segmentSeconds") || 30));
      doc.segments = segments;
      doc.finalText = polishFromSegments(segments);
      doc.asrStatus = "realtime";
      doc.asrProvider = "dashscope";
      await writeState(state);
      return json({ id: jobId, status: "done", stage: "dashscope_sync", docId: doc.id, completedSegments: segments, plannedSegments: [{ start: 0, end: doc.durationSeconds || 0 }] }, 201);
    } catch (error) {
      doc.asrStatus = "error";
      doc.asrError = error instanceof Error ? error.message : String(error);
      await writeState(state);
      return json({ id: jobId, status: "error", stage: "dashscope_sync", docId: doc.id, asrError: doc.asrError, completedSegments: [], plannedSegments: [] }, 201);
    }
  }

  if (request.method === "GET" && path === "/api/realtime") {
    return json({ status: "done", completedSegments: [], plannedSegments: [] });
  }

  if (request.method === "POST" && path === "/api/suggestions") {
    const state = await readState();
    state.targetDocument = (await request.json()).targetDocument || "";
    state.suggestions = [];
    return json(await writeState(state));
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
