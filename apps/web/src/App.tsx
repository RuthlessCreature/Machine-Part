import { useMemo, useState } from "react";
import { AssemblyViewer } from "./components/AssemblyViewer";
import {
  bomCsvUrl,
  bomXlsxUrl,
  createProject,
  drawingUrl,
  getAssemblyCandidates,
  getCosting,
  getDrawings,
  getManifest,
  getProject,
  glbUrl,
  quotationPdfUrl,
  reviseDrawing,
  runPipeline,
  selectAssembly,
  uploadSource
} from "./lib/api";
import type {
  AssemblyCandidate,
  AssemblyCandidateResponse,
  CostingResult,
  DrawingIndex,
  Manifest,
  Project
} from "./types";
import "./styles.css";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [drawings, setDrawings] = useState<DrawingIndex | null>(null);
  const [costing, setCosting] = useState<CostingResult | null>(null);
  const [assemblyChoice, setAssemblyChoice] = useState<AssemblyCandidateResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [costSelected, setCostSelected] = useState<Set<string>>(new Set());
  const [activeDrawingId, setActiveDrawingId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"3d" | "drawing" | "costing">("3d");
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
      setActiveDrawingId(current =>
        current && index.drawings.some(d => d.part_id === current)
          ? current
          : index.drawings[0]?.part_id ?? null
      );
      setCostSelected(current => current.size ? current : new Set(index.drawings.map(d => d.part_id)));
    }
    if (p.current_stage >= 3) setCosting(await getCosting(id));
  }

  async function poll(id: string, target: 1 | 2 | 3): Promise<Project> {
    for (let i = 0; i < 300; i++) {
      const p = await getProject(id);
      setProject(p);
      setMessage(`状态：${p.status}`);

      if (p.status === "failed") throw new Error(p.last_error || "流水线失败");

      if (p.status === "assembly_selection_required" || p.status === "converter_required") {
        const candidates = await getAssemblyCandidates(id);
        setAssemblyChoice(candidates);
        setMessage(
          p.status === "converter_required"
            ? "当前 CAD 格式需要 SolidWorks 转换适配器，系统不会伪解析"
            : "ZIP 已解析：请选择根装配体 / STEP 文件继续"
        );
        return p;
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

  function applyReachedStage(p: Project, target: 1 | 2 | 3) {
    if (p.status === "assembly_selection_required" || p.status === "converter_required") return;
    if (target === 1) {
      setMessage("阶段 1 完成：请选择需要出图的 Part");
      setViewMode("3d");
    } else if (target === 2) {
      setMessage("阶段 2 草稿完成：请逐张审核");
      setViewMode("drawing");
    } else {
      setMessage("一键到底完成：请审核图纸、核价假设与报价");
      setViewMode("costing");
    }
  }

  async function startNew() {
    if (!file) return;
    setBusy(true);
    setDrawings(null);
    setCosting(null);
    setManifest(null);
    setAssemblyChoice(null);
    setSelected(new Set());
    setCostSelected(new Set());
    try {
      setMessage("创建项目…");
      const p = await createProject(file.name.replace(/\.[^.]+$/, ""));
      setProject(p);
      setMessage("上传到 R2…");
      await uploadSource(p.id, file);
      setMessage(`启动流水线到阶段 ${targetStage}…`);
      await runPipeline(p.id, targetStage, [], instruction);
      const reached = await poll(p.id, targetStage);
      applyReachedStage(reached, targetStage);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseAssembly(candidate: AssemblyCandidate) {
    if (!project || candidate.requires_converter) return;
    setBusy(true);
    try {
      setMessage(`加载 ZIP 内装配体：${candidate.path}…`);
      await selectAssembly(project.id, candidate.path, targetStage, instruction);
      setAssemblyChoice(null);
      const reached = await poll(project.id, targetStage);
      applyReachedStage(reached, targetStage);
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
      const reached = await poll(project.id, 2);
      if (reached.current_stage >= 2) {
        setViewMode("drawing");
        setMessage("阶段 2 草稿完成：请逐张审核，数值几何来自 CAD 内核");
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function advanceStage3() {
    if (!project || !costSelected.size) return;
    setBusy(true);
    try {
      setMessage(`正在核价 ${costSelected.size} 张图纸对应的 Part…`);
      await runPipeline(project.id, 3, Array.from(costSelected), instruction);
      const reached = await poll(project.id, 3);
      if (reached.current_stage >= 3) {
        setViewMode("costing");
        setMessage("阶段 3 完成：报价仍需核对材料价格、机时参数和商业假设");
      }
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

  function toggleCost(id: string) {
    setCostSelected(prev => {
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
            <input
              type="file"
              accept=".step,.stp,.zip,.sldasm,.sldprt"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
            />
            <strong>{file ? file.name : "选择 STEP / ZIP / CAD 文件"}</strong>
            <small>STEP/STP 直接解析；ZIP 可选根装配体；原生 SolidWorks 需要转换适配器，不伪解析。</small>
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
            <textarea
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              placeholder="例如：材料 6061-T6，材料价 30 CNY/kg；机时 120 CNY/h；毛利率 25%；跳过标准件。"
            />
          </div>

          <button className="primary" disabled={!file || busy} onClick={startNew}>
            {busy ? "运行中…" : "新建并运行"}
          </button>

          {project && project.current_stage >= 1 && (
            <button className="secondary" disabled={!selected.size || busy} onClick={advanceStage2}>
              为所选 {selected.size} 个 Part 生成图纸
            </button>
          )}

          {project && project.current_stage >= 2 && (
            <button className="secondary" disabled={!costSelected.size || busy} onClick={advanceStage3}>
              核价所选 {costSelected.size} 张图纸
            </button>
          )}

          {manifest && <div className="metrics">
            <div><b>{manifest.counts.parts}</b><span>Parts</span></div>
            <div><b>{drawings?.count ?? 0}</b><span>Drawings</span></div>
            <div><b>{costSelected.size}</b><span>To Cost</span></div>
          </div>}
        </aside>

        <section className="center-panel">
          {project && manifest && (
            <div className="view-switch">
              <button className={viewMode === "3d" ? "active" : ""} onClick={() => setViewMode("3d")}>3D 装配体</button>
              <button className={viewMode === "drawing" ? "active" : ""} disabled={!drawings} onClick={() => setViewMode("drawing")}>2D 工程图</button>
              <button className={viewMode === "costing" ? "active" : ""} disabled={!costing} onClick={() => setViewMode("costing")}>核价 / 报价</button>
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
                <textarea
                  value={reviewFeedback}
                  onChange={e => setReviewFeedback(e.target.value)}
                  placeholder="例如：主视图改为从 +X 看；隐藏线关闭；增加备注。若要求无法由 CAD 证据安全完成，会列为 unresolved。"
                />
                <button className="primary" disabled={!reviewFeedback.trim() || busy} onClick={submitRevision}>
                  AI 理解意见并生成新 Revision
                </button>
              </div>
            </div>
          )}

          {project && costing && viewMode === "costing" && (
            <div className="costing-workbench">
              <div className="cost-summary">
                <div><span>Estimated cost</span><b>{costing.totals.estimated_cost.toFixed(2)} {costing.currency}</b></div>
                <div><span>Quoted price</span><b>{costing.totals.quoted_price.toFixed(2)} {costing.currency}</b></div>
                <div><span>Quote state</span><b>{costing.quote_complete ? "Complete inputs" : "Missing material price / inputs"}</b></div>
              </div>
              <div className="artifact-links costing-links">
                <a href={bomXlsxUrl(project.id)} target="_blank" rel="noreferrer">BOM.xlsx</a>
                <a href={bomCsvUrl(project.id)} target="_blank" rel="noreferrer">BOM.csv</a>
                <a href={quotationPdfUrl(project.id)} target="_blank" rel="noreferrer">Quotation.pdf</a>
              </div>
              {!costing.quote_complete && (
                <div className="warning-banner">
                  当前报价不完整：材料价格或关键材料参数缺失。系统没有瞎猜市场价，请补充后重跑。
                </div>
              )}
              <div className="cost-table-wrap">
                <table className="cost-table">
                  <thead>
                    <tr><th>Part</th><th>Qty</th><th>Material</th><th>Mass kg</th><th>Cycle min</th><th>Unit cost</th><th>Unit quote</th><th>Extended</th></tr>
                  </thead>
                  <tbody>
                    {costing.lines.map(line => <tr key={line.part_id}>
                      <td>{line.part_name}</td><td>{line.quantity}</td><td>{line.material}</td>
                      <td>{line.mass_kg.toFixed(3)}</td><td>{line.cycle_minutes.toFixed(1)}</td>
                      <td>{line.unit_cost.toFixed(2)}</td><td>{line.unit_quote.toFixed(2)}</td><td>{line.extended_quote.toFixed(2)}</td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!manifest && !assemblyChoice && (
            <div className="empty-view">
              <div className="wirecube"/>
              <h1>装配体视窗</h1>
              <p>上传真实 CAD 后，OCCT 在 Cloudflare Container 内解析并输出 GLB。</p>
            </div>
          )}

          {assemblyChoice && (
            <div className="assembly-picker">
              <div className="assembly-card">
                <div className="assembly-card-head">
                  <span>ZIP / Native CAD</span>
                  <h3>{assemblyChoice.status === "converter_required" ? "需要 CAD 转换适配器" : "选择根装配体"}</h3>
                  <p>{assemblyChoice.note || "请选择 ZIP 内要继续处理的装配体或 STEP 文件。"}</p>
                </div>

                {assemblyChoice.status === "converter_required" && !assemblyChoice.candidates?.length && (
                  <div className="converter-block">
                    原生 SolidWorks 文件不能由 OpenCascade 可靠解析。当前项目已明确停止，而不是生成假几何。
                    后续只需实现 converter adapter，将 SLDASM/SLDPRT 转为 STEP AP242/AP214，后面的 3D、出图和核价链路无需重写。
                  </div>
                )}

                <div className="candidate-list">
                  {(assemblyChoice.candidates ?? []).map(candidate => (
                    <button
                      key={candidate.path}
                      className={candidate.requires_converter ? "candidate converter" : "candidate"}
                      disabled={candidate.requires_converter || busy}
                      onClick={() => chooseAssembly(candidate)}
                    >
                      <div>
                        <strong>{candidate.path}</strong>
                        <small>
                          {candidate.requires_converter
                            ? `${candidate.format.toUpperCase()} · 需要转换器`
                            : `${candidate.format.toUpperCase()} · 可直接解析`}
                        </small>
                      </div>
                      <span>{candidate.requires_converter ? "BLOCKED" : "继续 →"}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        <aside className="panel right-panel">
          <h2>{viewMode === "drawing" ? "Drawings" : viewMode === "costing" ? "Cost Lines" : "Parts"}</h2>
          <div className="parts-list">
            {viewMode === "3d" && parts.map(part => (
              <button key={part.id} className={selected.has(part.id) ? "part active" : "part"} onClick={() => toggle(part.id)}>
                <span>{part.name}</span>
                <small>{part.bbox_mm?.size?.map(v => v.toFixed(1)).join(" × ")} mm</small>
              </button>
            ))}
            {viewMode === "drawing" && drawings?.drawings.map(drawing => (
              <div key={drawing.part_id} className={activeDrawing?.part_id === drawing.part_id ? "drawing-row active" : "drawing-row"}>
                <button className="part" onClick={() => setActiveDrawingId(drawing.part_id)}>
                  <span>{drawing.part_name}</span>
                  <small>r{drawing.revision} · {drawing.features.length} cylindrical features</small>
                </button>
                <label className="cost-check">
                  <input type="checkbox" checked={costSelected.has(drawing.part_id)} onChange={() => toggleCost(drawing.part_id)} />
                  核价
                </label>
              </div>
            ))}
            {viewMode === "costing" && costing?.lines.map(line => (
              <div className="part static" key={line.part_id}>
                <span>{line.part_name}</span>
                <small>{line.extended_quote.toFixed(2)} {costing.currency}</small>
              </div>
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
