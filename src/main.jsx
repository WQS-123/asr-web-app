import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const AI_SETTINGS_KEY = "asr-review-studio-ai-settings-v1";
const THEME_KEY = "asr-review-studio-theme-v1";
const DEFAULT_AI_SETTINGS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat"
};
const SUPABASE_FUNCTION_URL = "https://nsysrnnnbvodxgoooyoj.supabase.co/functions/v1/asr-api";

const apiRequest = async (path, options = {}) => {
  const response = await fetch(path, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return payload;
};

const edgeRequest = (path, options = {}) => apiRequest(`${SUPABASE_FUNCTION_URL}${path}`, options);

const uploadFormWithProgress = (url, form, onProgress) => new Promise((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open("POST", url);
  request.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    onProgress(Math.round((event.loaded / event.total) * 100));
  };
  request.onload = () => {
    let payload = {};
    try {
      payload = request.responseText ? JSON.parse(request.responseText) : {};
    } catch {
      payload = {};
    }
    if (request.status >= 200 && request.status < 300) {
      resolve(payload);
      return;
    }
    const error = new Error(payload.error || `${request.status} ${request.statusText}`);
    error.status = request.status;
    reject(error);
  };
  request.onerror = () => reject(new Error("网络连接失败，音频没有上传成功。"));
  request.send(form);
});

const formatTime = (totalSeconds = 0) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const durationLabel = (doc) => {
  const ends = (doc?.segments || []).map((segment) => Number(segment.end) || 0);
  const seconds = doc?.durationSeconds || Math.max(0, ...ends);
  return seconds ? `${Math.max(1, Math.ceil(seconds / 60))} 分钟` : "-";
};

const isCalibrationReady = (doc) => {
  const status = String(doc?.asrStatus || "").toLowerCase();
  return Boolean(doc?.segments?.length) && !["ready", "running", "paused", "error", "canceled"].includes(status);
};

const isAsrActive = (doc) => ["running", "paused"].includes(String(doc?.asrStatus || "").toLowerCase());

const loadAiSettings = () => {
  try {
    return { ...DEFAULT_AI_SETTINGS, ...JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || "{}") };
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
};

const loadTheme = () => {
  try {
    return localStorage.getItem(THEME_KEY) || "light";
  } catch {
    return "light";
  }
};

function App() {
  const [state, setState] = useState(null);
  const [activeDocId, setActiveDocId] = useState("");
  const [status, setStatus] = useState("Ready");
  const [modal, setModal] = useState("");
  const [importProgress, setImportProgress] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [asrBusy, setAsrBusy] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [topicDraft, setTopicDraft] = useState({ name: "", context: "" });
  const [importDraft, setImportDraft] = useState({ topicId: "", file: null, durationSeconds: "" });
  const [segmentSeconds, setSegmentSeconds] = useState(30);
  const [activeJobId, setActiveJobId] = useState("");
  const [currentJob, setCurrentJob] = useState(null);
  const [targetDocument, setTargetDocument] = useState("");
  const [dragTopicId, setDragTopicId] = useState("");
  const [dragDocId, setDragDocId] = useState("");
  const [dragOverDocId, setDragOverDocId] = useState("");
  const [dragOverTopicId, setDragOverTopicId] = useState("");
  const [aiSettings, setAiSettings] = useState(loadAiSettings);
  const [theme, setTheme] = useState(loadTheme);
  const [openRowMenu, setOpenRowMenu] = useState("");
  const [collapsedTopicIds, setCollapsedTopicIds] = useState([]);
  const audioRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const refreshState = async () => {
    try {
      const payload = await apiRequest("/api/state");
      setState(payload);
      setActiveDocId((current) => current || payload.selectedDocId || "");
      setTargetDocument(payload.targetDocument || "");
      setAuthRequired(false);
      return payload;
    } catch (error) {
      if (error.status === 401) {
        setAuthRequired(true);
        setStatus("需要访问密码");
        return null;
      }
      setStatus(`API unavailable: ${error.message}`);
      return null;
    }
  };

  useEffect(() => {
    refreshState();
  }, []);

  useEffect(() => {
    if (!activeJobId) return undefined;
    const poll = window.setInterval(async () => {
      try {
        const job = await apiRequest(`/api/realtime?jobId=${encodeURIComponent(activeJobId)}`);
        setCurrentJob(job);
        setStatus(jobStatusLabel(job));
        await refreshState();
        if (["done", "error", "canceled"].includes(String(job.status || "").toLowerCase())) {
          window.clearInterval(poll);
          setActiveJobId("");
        }
      } catch (error) {
        setStatus(`转录状态读取失败：${error.message}`);
        window.clearInterval(poll);
        setActiveJobId("");
      }
    }, 1800);
    return () => window.clearInterval(poll);
  }, [activeJobId, activeDocId]);

  const topics = state?.topics || [];
  const docs = state?.docs || [];
  const activeDoc = docs.find((doc) => doc.id === activeDocId) || null;
  const activeTopic = topics.find((topic) => topic.id === activeDoc?.topicId) || topics.find((topic) => topic.id === state?.selectedTopicId) || topics[0] || null;
  const docsByTopic = useMemo(() => {
    const grouped = new Map();
    docs.forEach((doc) => grouped.set(doc.topicId, [...(grouped.get(doc.topicId) || []), doc]));
    return grouped;
  }, [docs]);

  useEffect(() => {
    if (!importDraft.topicId && activeTopic?.id) setImportDraft((current) => ({ ...current, topicId: activeTopic.id }));
  }, [activeTopic?.id, importDraft.topicId]);

  const updateState = async (nextState) => {
    setState(nextState);
    try {
      const saved = await apiRequest("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextState)
      });
      setState(saved);
      return saved;
    } catch (error) {
      setStatus(`Save failed: ${error.message}`);
      return nextState;
    }
  };

  const login = async (event) => {
    event.preventDefault();
    try {
      await apiRequest("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: authPassword })
      });
      setAuthPassword("");
      await refreshState();
      setStatus("已登录");
    } catch (error) {
      setStatus(error.message);
    }
  };

  const selectTopic = (topic) => {
    setState((current) => ({ ...current, selectedTopicId: topic.id, selectedDocId: "" }));
    setActiveDocId("");
  };

  const selectDoc = (doc) => {
    setActiveDocId(doc.id);
    setState((current) => ({ ...current, selectedTopicId: doc.topicId, selectedDocId: doc.id }));
    if (audioRef.current && doc.audioUrl) audioRef.current.src = doc.audioUrl;
  };

  const createTopic = async (event) => {
    event.preventDefault();
    const draft = {
      id: `topic-pending-${Date.now()}`,
      name: topicDraft.name.trim() || "Untitled",
      context: topicDraft.context.trim(),
      glossary: {}
    };
    setState((current) => ({
      ...current,
      topics: [draft, ...(current?.topics || [])],
      selectedTopicId: draft.id,
      selectedDocId: "",
      expandedTopicIds: [...new Set([...(current?.expandedTopicIds || []), draft.id])]
    }));
    setStatus("文件夹创建中...");
    setModal("");
    setTopicDraft({ name: "", context: "" });
    try {
      const payload = await apiRequest("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(topicDraft)
      });
      setState(payload);
      setStatus("文件夹已创建");
    } catch (error) {
      setStatus(`文件夹创建失败：${error.message}`);
      await refreshState();
    }
  };

  const saveDoc = async (docId, fields) => {
    const payload = await apiRequest(`/api/docs/${encodeURIComponent(docId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields)
    });
    setState(payload);
    setStatus("Saved");
  };

  const saveActiveDoc = async (fields) => {
    if (!activeDoc) return;
    await saveDoc(activeDoc.id, fields);
  };

  const saveTopic = async (topicId, fields) => {
    const payload = await apiRequest(`/api/topics/${encodeURIComponent(topicId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields)
    });
    setState(payload);
    setStatus("Saved");
  };

  const renameTopic = async (topic) => {
    const name = window.prompt("文件夹名称", topic.name);
    if (!name || name.trim() === topic.name) return;
    await saveTopic(topic.id, { name: name.trim() });
  };

  const renameDoc = async (doc) => {
    const title = window.prompt("文件名称", doc.title);
    if (!title || title.trim() === doc.title) return;
    await saveDoc(doc.id, { title: title.trim() });
  };

  const deleteTopic = async (topic) => {
    if (!window.confirm(`删除文件夹「${topic.name}」及其中所有文件？`)) return;
    setStatus("文件夹删除中...");
    try {
      const payload = await apiRequest(`/api/topics/${encodeURIComponent(topic.id)}`, { method: "DELETE" });
      setState(payload);
      if (activeDoc?.topicId === topic.id) setActiveDocId("");
      setStatus("文件夹已删除");
    } catch (error) {
      setStatus(`文件夹删除失败：${error.message}`);
    }
  };

  const deleteDoc = async (doc) => {
    if (!window.confirm(`删除文件「${doc.title}」？`)) return;
    const payload = await apiRequest(`/api/docs/${encodeURIComponent(doc.id)}`, { method: "DELETE" });
    setState(payload);
    if (activeDocId === doc.id) setActiveDocId("");
    setStatus("文件已删除");
  };

  const moveDocToTopic = async (docId, topicId) => {
    if (!docId || !topicId) return;
    await saveDoc(docId, { topicId });
    setDragDocId("");
    setDragOverDocId("");
    setDragOverTopicId("");
  };

  const reorderDoc = async (targetDocId, targetTopicId) => {
    if (!dragDocId || dragDocId === targetDocId) return;
    const moving = docs.find((doc) => doc.id === dragDocId);
    const target = docs.find((doc) => doc.id === targetDocId);
    if (!moving || !target) return;
    const movedDoc = { ...moving, topicId: targetTopicId };
    const remaining = docs.filter((doc) => doc.id !== dragDocId);
    const targetIndex = remaining.findIndex((doc) => doc.id === targetDocId);
    if (targetIndex < 0) return;
    const nextDocs = [...remaining.slice(0, targetIndex), movedDoc, ...remaining.slice(targetIndex)];
    await updateState({ ...state, docs: nextDocs, selectedTopicId: targetTopicId, selectedDocId: movedDoc.id });
    setDragDocId("");
    setDragTopicId("");
    setDragOverDocId("");
    setDragOverTopicId("");
  };

  const reorderTopic = async (targetTopicId) => {
    if (!dragTopicId || dragTopicId === targetTopicId) return;
    const moving = topics.find((topic) => topic.id === dragTopicId);
    const targetIndex = topics.findIndex((topic) => topic.id === targetTopicId);
    if (!moving || targetIndex < 0) return;
    const remaining = topics.filter((topic) => topic.id !== dragTopicId);
    const nextTopics = [...remaining.slice(0, targetIndex), moving, ...remaining.slice(targetIndex)];
    await updateState({ ...state, topics: nextTopics });
    setDragTopicId("");
    setDragOverTopicId("");
  };

  const importAudio = async (event) => {
    event.preventDefault();
    if (!importDraft.file || !importDraft.topicId) return;
    setIsImporting(true);
    setImportProgress(0);
    setStatus("音频导入中...");
    const form = new FormData();
    form.append("topicId", importDraft.topicId);
    form.append("audio", importDraft.file);
    if (importDraft.durationSeconds) form.append("durationSeconds", importDraft.durationSeconds);
    try {
      const result = await uploadFormWithProgress(`${SUPABASE_FUNCTION_URL}/api/audio/import`, form, (progress) => {
        setImportProgress(progress);
        setStatus(`音频上传中 ${progress}%`);
      });
      setState(result.state);
      setActiveDocId(result.doc.id);
      setImportDraft({ topicId: importDraft.topicId, file: null, durationSeconds: "" });
      setModal("");
      setStatus("音频已导入");
    } catch (error) {
      setStatus(`音频导入失败：${error.message}`);
    } finally {
      setIsImporting(false);
    }
  };

  const startRealtime = async () => {
    if (!activeDoc) {
      setStatus("请先选择一个音频文件");
      return;
    }
    setAsrBusy(true);
    setCurrentJob({
      id: "pending-asr",
      docId: activeDoc.id,
      status: "running",
      stage: "uploading_to_asr",
      completedSegments: [],
      plannedSegments: [{ start: 0, end: activeDoc.durationSeconds || 0 }]
    });
    setStatus("ASR 启动中，请稍等...");
    const form = new FormData();
    form.append("docId", activeDoc.id);
    form.append("topicId", activeDoc.topicId);
    form.append("segmentSeconds", String(segmentSeconds));
    form.append("durationSeconds", String(activeDoc.durationSeconds || 0));
    try {
      const job = await edgeRequest("/api/realtime/start", { method: "POST", body: form });
      setCurrentJob(job);
      setActiveJobId(job.id);
      setStatus(job.status === "error" ? (job.asrError || "转录失败") : "转录已完成");
      await refreshState();
    } catch (error) {
      setStatus(error.message || "转录启动失败");
    } finally {
      setAsrBusy(false);
    }
  };

  const pauseRealtime = async () => {
    if (!activeJobId) return;
    const job = await apiRequest("/api/realtime/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: activeJobId })
    });
    setCurrentJob(job);
    setStatus(jobStatusLabel(job));
    await refreshState();
  };

  const resumeRealtime = async () => {
    if (!activeJobId) return;
    const job = await apiRequest("/api/realtime/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: activeJobId })
    });
    setCurrentJob(job);
    setStatus(jobStatusLabel(job));
    await refreshState();
  };

  const cancelRealtime = async () => {
    if (!activeJobId) return;
    const job = await apiRequest("/api/realtime/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: activeJobId })
    });
    setCurrentJob(job);
    setActiveJobId("");
    setStatus("转录已取消");
    await refreshState();
  };

  const restartRealtime = async () => {
    if (!activeDoc?.audioUrl) return;
    if (activeJobId) {
      await apiRequest("/api/realtime/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: activeJobId })
      });
      setActiveJobId("");
    }
    setCurrentJob(null);
    setStatus("重新转录中...");
    await startRealtime();
  };

  const calibrate = async (mode) => {
    if (!activeDoc) return;
    if (!isCalibrationReady(activeDoc)) {
      setStatus("语音转录完成后才可以使用校准");
      return;
    }
    if (!aiSettings.apiKey) {
      setModal("ai");
      setStatus("请先填写 AI API Key");
      return;
    }
    setStatus(`${mode === "file" ? "File" : "Context"} 校准中...`);
    try {
      const result = await apiRequest(`/api/calibrate/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId: activeDoc.id,
          apiKey: aiSettings.apiKey,
          baseUrl: aiSettings.baseUrl,
          model: aiSettings.model
        })
      });
      setState(result.state);
      setActiveDocId(result.doc.id);
      setModal("final");
      setStatus("校准完成");
    } catch (error) {
      setStatus(error.message);
    }
  };

  const createSuggestions = async () => {
    if (!activeDoc) return;
    const payload = await apiRequest("/api/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId: activeDoc.id, targetDocument })
    });
    setState(payload);
    setStatus("建议已生成");
  };

  const exportMarkdown = () => {
    if (!activeDoc || !activeTopic) return;
    const content = [
      `# ${activeDoc.title}`,
      "",
      `> Folder: ${activeTopic.name}`,
      "",
      "## Final",
      activeDoc.finalText || "",
      "",
      "## Timestamped Transcript",
      "",
      ...(activeDoc.segments || []).flatMap((segment) => [
        `### [${formatTime(segment.start)}-${formatTime(segment.end)}]`,
        segment.text,
        ""
      ])
    ].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    link.download = `${activeDoc.title}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const seekAudio = (deltaSeconds) => {
    const audio = audioRef.current;
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + deltaSeconds));
  };

  const toggleTopicCollapsed = (topicId) => {
    setCollapsedTopicIds((ids) => ids.includes(topicId) ? ids.filter((id) => id !== topicId) : [...ids, topicId]);
  };

  if (authRequired) {
    return (
      <main className="react-auth">
        <form onSubmit={login}>
          <div className="react-brand"><span>A</span><strong>ASR Review Studio</strong></div>
          <label>访问密码<input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} autoFocus /></label>
          <button className="react-primary" type="submit">进入</button>
          <p>{status}</p>
        </form>
      </main>
    );
  }

  if (!state) {
    return <main className="react-loading">Loading ASR Review Studio...</main>;
  }

  const jobForActiveDoc = currentJob && currentJob.docId === activeDoc?.id ? currentJob : null;
  const activeJobStatus = String(jobForActiveDoc?.status || "").toLowerCase();
  const showRestart = Boolean(activeDoc?.audioUrl && (activeJobId || activeDoc?.segments?.length || String(activeDoc?.asrStatus || "").toLowerCase() !== "ready"));

  return (
    <main className="react-shell">
      <aside className="react-sidebar">
        <div className="react-brand"><span>A</span><strong>ASR Review Studio</strong></div>
        <div className="react-sidebar-actions">
          <button className="react-primary" onClick={() => setModal("topic")}>新建文件夹</button>
          <button onClick={() => setModal("import")} disabled={!topics.length}>导入音频</button>
          <button className="react-icon-text" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            <Icon name={theme === "dark" ? "sun" : "moon"} />
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
        <div className="react-folder-list">
          {topics.map((topic) => {
            const isTopicCollapsed = collapsedTopicIds.includes(topic.id);
            return (
            <section
              key={topic.id}
              className="react-folder"
              draggable={!openRowMenu}
              onDragStart={() => {
                setDragTopicId(topic.id);
                setDragDocId("");
              }}
              onDragEnd={() => {
                setDragTopicId("");
                setDragDocId("");
                setDragOverDocId("");
                setDragOverTopicId("");
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (dragDocId) setDragOverTopicId(topic.id);
              }}
              onDragLeave={() => {
                if (dragOverTopicId === topic.id) setDragOverTopicId("");
              }}
              onDrop={() => dragDocId ? moveDocToTopic(dragDocId, topic.id) : reorderTopic(topic.id)}
            >
              <div className={`react-folder-row ${topic.id === activeTopic?.id ? "active" : ""} ${isTopicCollapsed ? "collapsed" : ""} ${dragOverTopicId === topic.id ? "drop-target" : ""}`}>
                <button onClick={() => selectTopic(topic)} onDoubleClick={() => renameTopic(topic)} aria-expanded={!isTopicCollapsed}>
                  <span className="folder-glyph" />
                  <strong>{topic.name}</strong>
                  <small>{(docsByTopic.get(topic.id) || []).length}</small>
                </button>
                <div className={`react-row-menu ${openRowMenu === `topic-${topic.id}` ? "open" : ""}`}>
                  <button
                    type="button"
                    className="react-row-menu-trigger"
                    title="更多"
                    aria-label={`${topic.name} 更多操作`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setOpenRowMenu(openRowMenu === `topic-${topic.id}` ? "" : `topic-${topic.id}`);
                    }}
                  >
                    <Icon name="more" />
                  </button>
                  <div className="react-row-menu-panel">
                    <button onClick={(event) => { event.stopPropagation(); setOpenRowMenu(""); toggleTopicCollapsed(topic.id); }}><Icon name="folder" />{isTopicCollapsed ? "展开" : "收起"}</button>
                    <button onClick={(event) => { event.stopPropagation(); setOpenRowMenu(""); renameTopic(topic); }}><Icon name="edit" />重命名</button>
                    <button className="danger" onClick={(event) => { event.stopPropagation(); setOpenRowMenu(""); deleteTopic(topic); }}><Icon name="trash" />删除</button>
                  </div>
                </div>
              </div>
              {!isTopicCollapsed && (docsByTopic.get(topic.id) || []).map((doc) => (
                <div
                  key={doc.id}
                  className={`react-file-row ${doc.id === activeDocId ? "selected" : ""} ${dragDocId === doc.id ? "dragging" : ""} ${dragOverDocId === doc.id ? "drop-before" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    event.stopPropagation();
                    setDragDocId(doc.id);
                    setDragTopicId("");
                  }}
                  onDragEnd={() => {
                    setDragDocId("");
                    setDragOverDocId("");
                    setDragOverTopicId("");
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (dragDocId && dragDocId !== doc.id) setDragOverDocId(doc.id);
                  }}
                  onDragLeave={() => {
                    if (dragOverDocId === doc.id) setDragOverDocId("");
                  }}
                  onDrop={(event) => {
                    event.stopPropagation();
                    reorderDoc(doc.id, topic.id);
                  }}
                >
                  <button className="react-file" onClick={() => selectDoc(doc)} onDoubleClick={() => renameDoc(doc)}>
                    <span>{doc.title}</span>
                    <small>{durationLabel(doc)}</small>
                  </button>
                  <div className={`react-row-menu ${openRowMenu === `doc-${doc.id}` ? "open" : ""}`}>
                    <button
                      type="button"
                      className="react-row-menu-trigger"
                      title="更多"
                      aria-label={`${doc.title} 更多操作`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setOpenRowMenu(openRowMenu === `doc-${doc.id}` ? "" : `doc-${doc.id}`);
                      }}
                    >
                      <Icon name="more" />
                    </button>
                    <div className="react-row-menu-panel">
                      <button onClick={(event) => { event.stopPropagation(); setOpenRowMenu(""); renameDoc(doc); }}><Icon name="edit" />重命名</button>
                      <button className="danger" onClick={(event) => { event.stopPropagation(); setOpenRowMenu(""); deleteDoc(doc); }}><Icon name="trash" />删除</button>
                    </div>
                  </div>
                </div>
              ))}
            </section>
          );})}
        </div>
      </aside>

      <section className="react-workspace">
        <header className="react-topbar">
          <div className="react-title-block">
            <span>{activeTopic?.name || "Project"}</span>
            <h1>{activeDoc?.title || "Select an audio document"}</h1>
          </div>
          <div className="react-topbar-audio">
            <audio ref={audioRef} controls src={activeDoc?.audioUrl || ""} />
            <div className="react-audio-skip-group" aria-label="音频跳转">
              <button type="button" className="react-audio-seek" title="快退 15 秒" aria-label="快退 15 秒" onClick={() => seekAudio(-15)}>-15</button>
              <button type="button" className="react-audio-seek" title="快进 15 秒" aria-label="快进 15 秒" onClick={() => seekAudio(15)}>+15</button>
            </div>
          </div>
          <div className="react-asr-controls">
            <label>片段秒数<input type="number" min="5" max="300" step="5" value={segmentSeconds} onChange={(event) => setSegmentSeconds(Number(event.target.value) || 30)} /></label>
            {!activeJobId && !showRestart && <button className="react-primary" disabled={!activeDoc?.audioUrl || isAsrActive(activeDoc) || asrBusy} onClick={startRealtime}>{asrBusy ? "ASR..." : "Start ASR"}</button>}
            {activeJobId && activeJobStatus !== "paused" && <button className="react-primary" onClick={pauseRealtime}>Pause</button>}
            {activeJobId && activeJobStatus === "paused" && <button className="react-primary" onClick={resumeRealtime}>Continue</button>}
            {showRestart && <button onClick={restartRealtime} disabled={!activeDoc?.audioUrl}>Restart</button>}
          </div>
          <div className={`react-asr-progress ${activeJobId || asrBusy ? "active" : ""}`} aria-live="polite">
              <strong>{asrProgressTitle(jobForActiveDoc, activeDoc)}</strong>
              <span>{status || asrProgressDetail(jobForActiveDoc, activeDoc)}</span>
          </div>
        </header>

        <section className="react-transcript-card">
          <div className="react-card-heading">
            <div>
              <span>实时转录</span>
              <h2>{activeDoc ? asrStatusText(activeDoc) : "选择音频后开始"}</h2>
            </div>
          </div>
          {activeDoc?.asrError && <p className="react-error">{activeDoc.asrError}</p>}
          <div className="react-segments">
            {(activeDoc?.segments || []).map((segment, index) => (
              <article key={`${segment.start}-${index}`}>
                <button onClick={() => {
                  if (!audioRef.current) return;
                  audioRef.current.currentTime = Number(segment.start) || 0;
                  audioRef.current.play().catch(() => {});
                }}>
                  {formatTime(segment.start)}-{formatTime(segment.end)}
                </button>
                <p
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={(event) => {
                    const nextSegments = activeDoc.segments.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, text: event.currentTarget.textContent.trim() } : item
                    );
                    saveActiveDoc({ segments: nextSegments });
                  }}
                >
                  {segment.text}
                </p>
              </article>
            ))}
            {!activeDoc?.segments?.length && <div className="react-empty">暂无转录片段</div>}
          </div>
        </section>

        <nav className="react-bottom-dock" aria-label="文档工具">
          <button onClick={() => setModal("final")} disabled={!activeDoc}>校正文档</button>
          <button onClick={() => setModal("context")} disabled={!activeTopic}>Context</button>
          <button onClick={() => setModal("suggestions")} disabled={!activeDoc}>建议对比</button>
          <button disabled={!isCalibrationReady(activeDoc)} onClick={() => calibrate("context")}>Context 校准</button>
          <button disabled={!isCalibrationReady(activeDoc)} onClick={() => calibrate("file")}>File 校准</button>
          <button onClick={() => setModal("ai")}>AI 设置</button>
          <button onClick={exportMarkdown} disabled={!activeDoc}>导出 MD</button>
        </nav>
      </section>

      {modal === "topic" && (
        <Modal title="新建文件夹" onClose={() => setModal("")}>
          <form className="react-form" onSubmit={createTopic}>
            <label>名称<input value={topicDraft.name} onChange={(event) => setTopicDraft({ ...topicDraft, name: event.target.value })} autoFocus /></label>
            <label>Context<textarea value={topicDraft.context} onChange={(event) => setTopicDraft({ ...topicDraft, context: event.target.value })} /></label>
            <button className="react-primary" type="submit">创建</button>
          </form>
        </Modal>
      )}
      {modal === "import" && (
        <Modal title="导入音频" onClose={() => setModal("")}>
          <form className="react-form" onSubmit={importAudio}>
            <label>文件夹<select value={importDraft.topicId} onChange={(event) => setImportDraft({ ...importDraft, topicId: event.target.value })}>
              {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
            </select></label>
            <label>音频文件<input type="file" accept="audio/*,.m4a,.mp3,.wav,.aac" onChange={(event) => setImportDraft({ ...importDraft, file: event.target.files?.[0] || null })} /></label>
            <label>时长秒数<input type="number" min="0" value={importDraft.durationSeconds} onChange={(event) => setImportDraft({ ...importDraft, durationSeconds: event.target.value })} /></label>
            {isImporting && (
              <div className="react-upload-progress" aria-live="polite">
                <progress max="100" value={importProgress} />
                <span>上传中 {importProgress}%</span>
              </div>
            )}
            <button className="react-primary" type="submit" disabled={!importDraft.file || isImporting}>{isImporting ? "导入中..." : "导入"}</button>
          </form>
        </Modal>
      )}
      {modal === "final" && activeDoc && (
        <Modal title="已校正文档" onClose={() => setModal("")}>
          <textarea defaultValue={activeDoc.finalText || ""} onBlur={(event) => saveActiveDoc({ finalText: event.currentTarget.value })} />
        </Modal>
      )}
      {modal === "context" && activeTopic && (
        <Modal title="文件夹 Context" onClose={() => setModal("")}>
          <textarea defaultValue={activeTopic.context || ""} onBlur={(event) => saveTopic(activeTopic.id, { context: event.currentTarget.value })} />
        </Modal>
      )}
      {modal === "suggestions" && activeDoc && (
        <Modal title="建议对比" onClose={() => setModal("")}>
          <div className="react-suggestions">
            <textarea value={targetDocument} onChange={(event) => setTargetDocument(event.target.value)} />
            <button className="react-primary" onClick={createSuggestions}>生成建议</button>
            <div className="react-suggestion-list">
              {(state.suggestions || []).map((suggestion, index) => (
                <article key={`${suggestion.original}-${index}`}>
                  <p><strong>原文</strong>{suggestion.original}</p>
                  <p><strong>建议</strong>{suggestion.replacement}</p>
                  <small>{suggestion.reason}</small>
                </article>
              ))}
              {!state.suggestions?.length && <div className="react-empty">暂无建议</div>}
            </div>
          </div>
        </Modal>
      )}
      {modal === "ai" && (
        <Modal title="AI 设置" onClose={() => setModal("")}>
          <div className="react-form">
            <label>API Key<input type="password" value={aiSettings.apiKey} onChange={(event) => setAiSettings({ ...aiSettings, apiKey: event.target.value })} /></label>
            <label>Base URL<input value={aiSettings.baseUrl} onChange={(event) => setAiSettings({ ...aiSettings, baseUrl: event.target.value })} /></label>
            <label>Model<input value={aiSettings.model} onChange={(event) => setAiSettings({ ...aiSettings, model: event.target.value })} /></label>
            <button className="react-primary" onClick={() => {
              localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings));
              setModal("");
              setStatus("AI 设置已保存");
            }}>保存</button>
          </div>
        </Modal>
      )}
    </main>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="react-modal-backdrop" onClick={onClose}>
      <article className="react-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button onClick={onClose}>关闭</button>
        </header>
        {children}
      </article>
    </div>
  );
}

function Icon({ name }) {
  const icons = {
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="M19 6l-1 14H6L5 6" />
        <path d="M10 11v5" />
        <path d="M14 11v5" />
      </>
    ),
    moon: (
      <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z" />
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="m4.93 4.93 1.41 1.41" />
        <path d="m17.66 17.66 1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="m6.34 17.66-1.41 1.41" />
        <path d="m19.07 4.93-1.41 1.41" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1.4" />
        <circle cx="12" cy="12" r="1.4" />
        <circle cx="19" cy="12" r="1.4" />
      </>
    ),
    folder: (
      <>
        <path d="M3 7h7l2 2h9v10H3Z" />
        <path d="M3 7v12" />
      </>
    )
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {icons[name]}
    </svg>
  );
}

function asrStatusText(doc) {
  const status = String(doc?.asrStatus || "ready").toLowerCase();
  const labels = {
    ready: "等待转录",
    running: "转录中",
    paused: "已暂停",
    realtime: "转录完成",
    real: "转录完成",
    interrupted: "转录中断",
    error: "转录失败",
    canceled: "已取消"
  };
  return labels[status] || status;
}

function jobStatusLabel(job) {
  const status = String(job?.status || "");
  const stage = String(job?.stage || "");
  const completed = job?.completedSegments?.length || 0;
  const planned = job?.plannedSegments?.length || 0;
  if (status === "done") return "转录完成";
  if (status === "error") return job.asrError || "转录失败";
  if (status === "paused") return `已暂停 ${completed}/${planned || "?"}`;
  if (stage) return `${stage} ${completed}/${planned || "?"}`;
  return `转录中 ${completed}/${planned || "?"}`;
}

function asrProgressTitle(job, doc) {
  const status = String(job?.status || "").toLowerCase();
  const stage = String(job?.stage || "").toLowerCase();
  if (status === "paused") return "已暂停";
  if (status === "done") return "转录完成";
  if (status === "error") return "转录失败";
  if (status === "canceled") return "已取消";
  if (stage === "loading_model") return "加载模型";
  if (stage === "segmenting") return "切分音频";
  if (stage === "dashscope_submit") return "提交云端";
  if (stage === "dashscope_transcribing") return "云端转录中";
  if (stage === "dashscope_sync") return "本地直传转录";
  if (status === "running") return "转录中";
  if (doc?.segments?.length) return "已有转录";
  return "等待开始";
}

function asrProgressDetail(job, doc) {
  if (job) {
    const completed = job.completedSegments?.length || 0;
    const planned = job.plannedSegments?.length || 0;
    const index = Number(job.currentSegmentIndex);
    if (job.asrError) return job.asrError;
    if (planned) return `已完成 ${completed}/${planned} 个片段${Number.isFinite(index) ? `，当前第 ${index + 1} 段` : ""}`;
    if (completed) return `已生成 ${completed} 个片段`;
    return "正在准备转录任务";
  }
  const segmentCount = doc?.segments?.length || 0;
  if (segmentCount) return `已生成 ${segmentCount} 个片段，可点击 Restart 重新转录`;
  return doc?.audioUrl ? "点击 Start ASR 开始转录" : "请先导入或选择音频";
}

createRoot(document.getElementById("root")).render(<App />);
