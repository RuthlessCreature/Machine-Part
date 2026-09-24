import { useMemo, useState } from "react";
import { AssemblyViewer } from "./components/AssemblyViewer";
import { createProject, getManifest, getProject, glbUrl, runPipeline, uploadSource } from "./lib/api";
import type { Manifest, Project } from "./types";
import "./styles.css";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("等待上传 CAD 文件");
  const [instruction, setInstruction] = useState("");
  const [targetStage, setTargetStage] = useState<1 | 2 | 3>(1);

  const parts = useMemo(() => manifest?.nodes.filter(n => n.kind === "part") ?? [], [manifest]);
  const selectedNames = useMemo(() => new Set(parts.filter(p => selected.has(p.id)).map(p => p.name)), [parts, selected]);

  async function poll(id: string) {
    for (let i = 0; i < 180; i++) {
      const p = await getProject(id);
      setProject(p);
      setMessage(`状态：${p.status}`);
      if (["stage1_ready", "stage2_planned"].includes(p.status)) {
        const m = await getManifest(id);
        setManifest(m);
        return;
      }
      if (p.status === "assembly_selection_required") throw new Error("压缩包需要选择根装配体；该交互将在下一提交接上。STEP 可直接运行。 ");
      if (p.status === "failed") throw new Error(p.last_error || "流水线失败");
      await sleep(1200);
    }
    throw new Error("前端等待超时；后台 Workflow 仍可能继续运行");
  }

  async function start() {
    if (!file) return;
    setBusy(true);
    try {
      setMessage("创建项目…");
      const p = await createProject(file.name.replace(/\.[^.]+$/, ""));
      setProject(p);
      setMessage("上传到 R2…");
      await uploadSource(p.id, file);
      setMessage("启动 Cloudflare Workflow…");
      await runPipeline(p.id, targetStage, Array.from(selected), instruction);
      await poll(p.id);
      setMessage(targetStage === 1 ? "阶段 1 完成：装配体已解析并可交互选择零件" : "阶段 1 完成；阶段 2 AI 制图计划已生成，确定性制图引擎仍在开发门内");
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

  function pickByName(name: string) {
    const part = parts.find(p => p.name === name);
    if (part) toggle(part.id);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><b>Machine Part</b><span>CAD → Drawing → Costing</span></div>
        <div className="status-dot"><i />{message}</div>
      </header>

      <section className="workspace">
        <aside className="panel left-panel">
          <h2>01 · 输入</h2>
          <label className="dropzone">
            <input type="file" accept=".step,.stp,.zip,.sldasm,.sldprt,.igs,.iges" onChange={e => setFile(e.target.files?.[0] ?? null)} />
            <strong>{file ? file.name : "选择 STEP / ZIP / CAD 文件"}</strong>
            <small>STEP/STP 已接入；原生 SolidWorks 需要转换适配器，不伪解析。</small>
          </label>

          <div className="field">
            <label>运行目标</label>
            <select value={targetStage} onChange={e => setTargetStage(Number(e.target.value) as 1|2|3)}>
              <option value={1}>阶段 1 · 解析 / 拆件 / 3D</option>
              <option value={2}>阶段 2 · + 制图计划</option>
              <option value={3}>一键到底 · 目标报价</option>
            </select>
          </div>
          <div className="field">
            <label>一键到底 / 微调提示词</label>
            <textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：只处理自制机加工件；材料默认 6061-T6；跳过相机、气缸、标准件。" />
          </div>
          <button className="primary" disabled={!file || busy} onClick={start}>{busy ? "运行中…" : "开始运行"}</button>

          {manifest && <div className="metrics">
            <div><b>{manifest.counts.parts}</b><span>Parts</span></div>
            <div><b>{manifest.counts.assemblies}</b><span>Assemblies</span></div>
            <div><b>{selected.size}</b><span>Selected</span></div>
          </div>}
        </aside>

        <section className="center-panel">
          {project && manifest ? <AssemblyViewer url={glbUrl(project.id)} selectedNames={selectedNames} onPick={pickByName} /> :
            <div className="empty-view"><div className="wirecube"/><h1>装配体视窗</h1><p>上传真实 CAD 后，OCCT 在 Cloudflare Container 内解析并输出 GLB。</p></div>}
        </section>

        <aside className="panel right-panel">
          <h2>Parts</h2>
          <div className="parts-list">
            {parts.map(part => <button key={part.id} className={selected.has(part.id) ? "part active" : "part"} onClick={() => toggle(part.id)}>
              <span>{part.name}</span>
              <small>{part.bbox_mm?.size?.map(v => v.toFixed(1)).join(" × ")} mm</small>
            </button>)}
            {!parts.length && <p className="muted">阶段 1 完成后显示零件树。</p>}
          </div>
        </aside>
      </section>

      <footer className="stagebar">
        <span className={project?.current_stage! >= 1 ? "done" : ""}>1 装配解析</span>
        <span>2 国标工程图 / 人审 / AI修订</span>
        <span>3 工时材料核价 / BOM / 报价</span>
      </footer>
    </main>
  );
}
