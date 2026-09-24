import { useMemo, useState } from "react";
import { AssemblyViewer } from "./components/AssemblyViewer";
import {
  createProject,
  drawingUrl,
  getDrawings,
  getManifest,
  getProject,
  glbUrl,
  reviseDrawing,
  runPipeline,
  uploadSource
} from "./lib/api";
import type { DrawingIndex, Manifest, Project } from "./types";
import "./styles.css";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [drawings, setDrawings] = useState<DrawingIndex | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeDrawingId, setActiveDrawingId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"3d" | "drawing">("3d");
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("等待上传 CAD 文件");
  const [instruction, setInstruction] = useState("");
  const [targetStage, setTargetStage] = useState<1 | 2 | 3>(1);

  const parts = useMemo(() => manifest?.nodes.filter(n => n.kind === "part") ?? [], [manifest]);
  const activeDrawing = useMemo(
    () => drawings?.drawings.find(d => d.part_id === activeDrawingId) ?? drawings?.drawings[0] ?? null,
    [drawings, activeDrawingId]
  );

  async function loadArtifacts(id: string, p: Project) {
    if (p.current_stage >= 1) setManifest(await getManifest(id));
    if (p.current_stage >= 2) {
      const index = await getDrawings(id);
      setDrawings(index);
      setActiveDrawingId(current => current && index.drawings.some(d => d.part_id === current) ? current : index.drawings[0]?.part_id ?? null);
    }
  }

  async function poll(id: string, target: 1 | 2 | 3) {
    for (let i = 0; i < 300; i++) {
      const p = await getProject(id);
      setProject(p);
      setMessage(`状态：${p.status}`);
      if (p.status === "failed") throw new Error(p.last_error || "流水线失败");
      if (p.status === "assembly_selection_required") {
        throw new Error("压缩包需要选择根装配体；STEP/STP 可直接运行。");
      }
      const reached =
        (target === 1 && p.current_stage >= 1) ||
        (target === 2 && p.current_stage >= 2) ||
        (target === 3 && p.current_stage >= 3);
      if (reached) {
        await loadArtifacts(id, p);
        return p;
      }
      await sleep(1200);
    }
    throw new Error("前端等待超时；请检查 Workflow / Container 日志");
  }

  async function startNew() {
    if (!file) return;
    setBusy(true);
    setDrawings(null);
    setManifest(null);
    setSelected(new Set());
    try {
      setMessage("创建项目…");
      const p = await createProject(file.name.replace(/\.[^.]+$/, ""));
      setProject(p);
      setMessage("上传到 R2…");
      await uploadSource(p.id, file);
      setMessage(`启动流水线到阶段 ${targetStage}…`);
      await runPipeline(p.id, targetStage, [], instruction);
      await poll(p.id, targetStage);
      setMessage(targetStage === 1 ? "阶段 1 完成：请选择需要出图的 Part" : `已完成到阶段 ${targetStage}`);
      if (targetStage >= 2) setViewMode("drawing");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function advanceStage2() {
    if (!project || !selected.size) return;
    setBusy(true);
    try {
      setMessage(`正在为 ${selected.size} 个 Part 生成工程图…`);
      await runPipeline(project.id, 2, Array.from(selected), instruction);
      await poll(project.id, 2);
      setViewMode("drawing");
      setMessage("阶段 2 草稿完成：请逐张审核，数值几何来自 CAD 内核");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitRevision() {
    if (!project || !activeDrawing || !reviewFeedback.trim()) return;
    setBusy(true);
    try {
      setMessage(`提交 ${activeDrawing.part_name} 的修改意见…`);
      await reviseDrawing(project.id, activeDrawing.part_id, reviewFeedback.trim());
      await poll(project.id, 2);
      setActiveDrawingId(activeDrawing.part_id);
      setReviewFeedback("");
      setMessage("新 revision 已生成；未修改的其他图纸已继承保留");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function pickById(id: string) {
    if (parts.some(p => p.id === id)) toggle(id);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><b>Machine Part</b><span>CAD → Drawing → Costing</span></div>
        <div className="status-dot"><i />{message}</div>
      </header>

      <section className="workspace">
        <aside className="panel left-panel">
          <h2>01 · 输入与流水线</h2>
          <label className="dropzone">
            <input type="file" accept=".step,.stp,.zip,.sldasm,.sldprt,.igs,.iges" onChange={e => setFile(e.target.files?.[0] ?? null)} />
            <strong>{file ? file.name : "选择 STEP / ZIP / CAD 文件"}</strong>
            <small>STEP/STP 已接入；原生 SolidWorks 需要转换适配器，不伪解析。</small>
          </label>

          <div className="field">
            <label>新项目运行目标</label>
            <select value={targetStage} onChange={e => setTargetStage(Number(e.target.value) as 1|2|3)}>
              <option value={1}>阶段 1 · 解析 / 拆件 / 3D</option>
              <option value={2}>一键到阶段 2 · 全部 Part 出草图</option>
              <option value={3}>一键到底 · 图纸 + 核价 + 报价</option>
            </select>
          </div>

          <div className="field">
            <label>一键到底 / 微调提示词</label>
            <textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：材料默认 6061-T6；跳过标准件；报价币种 CNY；毛利率 25%。" />
          </div>

          <button className="primary" disabled={!file || busy} onClick={startNew}>{busy ? "运行中…" : "新建并运行"}</button>
          {project && project.current_stage >= 1 && (
            <button className="secondary" disabled={!selected.size || busy} onClick={advanceStage2}>
              为所选 {selected.size} 个 Part 生成图纸
            </button>
          )}

          {manifest && <div className="metrics">
            <div><b>{manifest.counts.parts}</b><span>Parts</span></div>
            <div><b>{manifest.counts.assemblies}</b><span>Assemblies</span></div>
            <div><b>{selected.size}</b><span>Selected</span></div>
          </div>}
        </aside>

        <section className="center-panel">
          {project && manifest && (
            <div className="view-switch">
              <button className={viewMode === "3d" ? "active" : ""} onClick={() => setViewMode("3d")}>3D 装配体</button>
              <button className={viewMode === "drawing" ? "active" : ""} disabled={!drawings} onClick={() => setViewMode("drawing")}>2D 工程图</button>
            </div>
          )}

          {project && manifest && viewMode === "3d" && (
            <AssemblyViewer url={glbUrl(project.id)} selectedIds={selected} onPick={pickById} />
          )}

          {project && activeDrawing && viewMode === "drawing" && (
            <div className="drawing-workbench">
              <div className="drawing-head">
                <div>
                  <strong>{activeDrawing.part_name}</strong>
                  <span>Revision {activeDrawing.revision} · {activeDrawing.part_id}</span>
                </div>
                <div className="artifact-links">
                  <a href={drawingUrl(project.id, activeDrawing.part_id, "pdf", activeDrawing.revision)} target="_blank" rel="noreferrer">PDF</a>
                  <a href={drawingUrl(project.id, activeDrawing.part_id, "dxf", activeDrawing.revision)} target="_blank" rel="noreferrer">DXF</a>
                  <a href={drawingUrl(project.id, activeDrawing.part_id, "json", activeDrawing.revision)} target="_blank" rel="noreferrer">JSON</a>
                </div>
              </div>
              <div className="drawing-canvas">
                <img src={drawingUrl(project.id, activeDrawing.part_id, "svg", activeDrawing.revision)} alt={activeDrawing.part_name} />
              </div>
              <div className="review-box">
                <textarea value={reviewFeedback} onChange={e => setReviewFeedback(e.target.value)} placeholder="输入这张图的修改意见，例如：主视图改为从 +X 看；补剖视图；M6 孔统一加深度标注；不要改 CAD 几何。" />
                <button className="primary" disabled={!reviewFeedback.trim() || busy} onClick={submitRevision}>AI 理解意见并生成新 Revision</button>
              </div>
            </div>
          )}

          {!manifest && (
            <div className="empty-view"><div className="wirecube"/><h1>装配体视窗</h1><p>上传真实 CAD 后，OCCT 在 Cloudflare Container 内解析并输出 GLB。</p></div>
          )}
        </section>

        <aside className="panel right-panel">
          <h2>{viewMode === "drawing" ? "Drawings" : "Parts"}</h2>
          <div className="parts-list">
            {viewMode === "3d" && parts.map(part => (
              <button key={part.id} className={selected.has(part.id) ? "part active" : "part"} onClick={() => toggle(part.id)}>
                <span>{part.name}</span>
                <small>{part.bbox_mm?.size?.map(v => v.toFixed(1)).join(" × ")} mm</small>
              </button>
            ))}
            {viewMode === "drawing" && drawings?.drawings.map(drawing => (
              <button key={drawing.part_id} className={activeDrawing?.part_id === drawing.part_id ? "part active" : "part"} onClick={() => setActiveDrawingId(drawing.part_id)}>
                <span>{drawing.part_name}</span>
                <small>r{drawing.revision} · {drawing.features.length} cylindrical features</small>
              </button>
            ))}
            {viewMode === "3d" && !parts.length && <p className="muted">阶段 1 完成后显示零件树。</p>}
            {viewMode === "drawing" && !drawings?.drawings.length && <p className="muted">阶段 2 完成后显示图纸列表。</p>}
          </div>
        </aside>
      </section>

      <footer className="stagebar">
        <span className={project?.current_stage! >= 1 ? "done" : ""}>1 装配解析</span>
        <span className={project?.current_stage! >= 2 ? "done" : ""}>2 工程图 / 人审 / 修订</span>
        <span className={project?.current_stage! >= 3 ? "done" : ""}>3 核价 / BOM / 报价</span>
      </footer>
    </main>
  );
}
