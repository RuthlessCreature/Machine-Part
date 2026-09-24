import { Bounds, Environment, OrbitControls, useGLTF } from "@react-three/drei";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useEffect, useMemo } from "react";
import * as THREE from "three";

function Model({ url, selectedIds, onPick }: { url: string; selectedIds: Set<string>; onPick: (id: string) => void }) {
  const gltf = useGLTF(url);
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);

  useEffect(() => {
    scene.traverse((obj: any) => {
      if (!obj.isMesh) return;
      if (!obj.userData.__baseMaterial) obj.userData.__baseMaterial = obj.material;
      const selected = selectedIds.has(obj.name);
      const mat = obj.userData.__baseMaterial.clone();
      if (selected) {
        if ("emissive" in mat) mat.emissive = new THREE.Color(0xff7a18);
        mat.opacity = 1;
        mat.transparent = false;
      } else {
        if ("emissive" in mat) mat.emissive = new THREE.Color(0x000000);
        mat.opacity = selectedIds.size ? 0.28 : 1;
        mat.transparent = selectedIds.size > 0;
      }
      obj.material = mat;
    });
    return () => {
      scene.traverse((obj: any) => {
        if (obj.isMesh && obj.material !== obj.userData.__baseMaterial) obj.material?.dispose?.();
      });
    };
  }, [scene, selectedIds]);

  const click = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const id = event.object.name;
    if (id) onPick(id);
  };

  return <primitive object={scene} onClick={click} />;
}

export function AssemblyViewer(props: { url: string; selectedIds: Set<string>; onPick: (id: string) => void }) {
  return (
    <div className="viewer">
      <Canvas camera={{ position: [3, 2, 3], fov: 42 }} dpr={[1, 2]}>
        <color attach="background" args={["#0a0d12"]} />
        <ambientLight intensity={1.6} />
        <directionalLight position={[4, 8, 6]} intensity={2.6} />
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.15}>
            <Model {...props} />
          </Bounds>
          <Environment preset="warehouse" />
        </Suspense>
        <OrbitControls makeDefault />
        <gridHelper args={[4000, 40, 0x273143, 0x18202c]} />
      </Canvas>
    </div>
  );
}
