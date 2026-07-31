"use client";

import { useEffect, useRef, useMemo, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Float, Sphere, MeshDistortMaterial } from "@react-three/drei";
import * as THREE from "three";

const PARTICLE_VERTEX = /* glsl */ `
  attribute float aSize;
  uniform float uTime;
  varying float vAlpha;
  void main() {
    vec3 pos = position;
    float h = fract(sin(dot(pos.xy, vec2(12.9898, 78.233))) * 43758.5453);
    float h2 = fract(sin(dot(pos.yz, vec2(39.346, 11.135))) * 42532.19);
    pos.x += sin(uTime * 0.5 + h * 6.2831) * 0.05;
    pos.y += cos(uTime * 0.4 + h2 * 6.2831) * 0.05;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = aSize * (160.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    vAlpha = 0.6;
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float alpha = smoothstep(0.5, 0.0, d) * vAlpha;
    gl_FragColor = vec4(0.29, 0.62, 1.0, alpha);
  }
`;

function ParticleField({ count = 1200 }) {
  const mesh = useRef<THREE.Points>(null);
  const material = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), []);

  const [positions, sizes] = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const sz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 100;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 100;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 100;
      sz[i] = Math.random() * 2 + 0.5;
    }
    return [pos, sz];
  }, [count]);

  useFrame(({ clock }) => {
    if (material.current) {
      material.current.uniforms.uTime.value = clock.getElapsedTime();
    }
    if (mesh.current) {
      mesh.current.rotation.y = clock.getElapsedTime() * 0.01;
    }
  });

  return (
    <points ref={mesh}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={positions}
          itemSize={3}
        />
        <bufferAttribute
          attach="attributes-aSize"
          count={count}
          array={sizes}
          itemSize={1}
        />
      </bufferGeometry>
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={PARTICLE_VERTEX}
        fragmentShader={PARTICLE_FRAGMENT}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function GlowingOrb() {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();
    meshRef.current.rotation.x = Math.sin(t * 0.2) * 0.1;
    meshRef.current.rotation.y = Math.sin(t * 0.3) * 0.15;
    const scale =
      1 + Math.sin(t * 0.5) * 0.02 + Math.sin(t * 1.5) * 0.01;
    meshRef.current.scale.setScalar(scale);
  });

  return (
    <Float speed={1.5} rotationIntensity={0.2} floatIntensity={0.5}>
      <Sphere ref={meshRef} args={[1, 64, 64]} scale={1.2}>
        <MeshDistortMaterial
          color="#4a9eff"
          emissive="#2563eb"
          emissiveIntensity={0.4}
          roughness={0.1}
          metalness={0.8}
          distort={0.15}
          speed={2}
          transparent
          opacity={0.95}
        />
      </Sphere>
    </Float>
  );
}

function EnergyRings() {
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!ringRef.current) return;
    const t = clock.getElapsedTime();
    ringRef.current.rotation.x = Math.sin(t * 0.2) * 0.3;
    ringRef.current.rotation.z = Math.cos(t * 0.15) * 0.2;
    ringRef.current.scale.setScalar(1 + Math.sin(t * 0.8) * 0.02);
  });

  return (
    <mesh ref={ringRef} rotation={[Math.PI / 2.5, 0, 0]}>
      <ringGeometry args={[1.6, 1.8, 64]} />
      <meshBasicMaterial
        color="#4a9eff"
        transparent
        opacity={0.2}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function OrbitalRings() {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = clock.getElapsedTime() * 0.1;
  });

  const rings = useMemo(() => {
    return Array.from({ length: 3 }, (_, i) => ({
      radius: 2 + i * 0.6,
      speed: 0.5 + i * 0.2,
      tilt: (i * Math.PI) / 3,
    }));
  }, []);

  return (
    <group ref={groupRef}>
      {rings.map((ring, i) => (
        <group key={i} rotation={[ring.tilt, 0, 0]}>
          <mesh>
            <ringGeometry args={[ring.radius, ring.radius + 0.05, 48]} />
            <meshBasicMaterial
              color={`hsl(${210 + i * 20}, 80%, 60%)`}
              transparent
              opacity={0.15}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Scene() {
  return (
    <>
      <color attach="background" args={["#000"]} />
      <ambientLight intensity={0.3} />
      <pointLight position={[10, 10, 10]} intensity={0.8} color="#4a9eff" />
      <pointLight position={[-10, -10, -10]} intensity={0.4} color="#7c3aed" />
      <GlowingOrb />
      <EnergyRings />
      <OrbitalRings />
      <ParticleField count={1200} />
    </>
  );
}

export function HeroScene() {
  const [frameloop, setFrameloop] = useState<"always" | "never">("always");

  useEffect(() => {
    const onVisibility = () => {
      setFrameloop(
        document.visibilityState === "visible" ? "always" : "never"
      );
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return (
    <div className="fixed inset-0 z-0">
      <Canvas
        frameloop={frameloop}
        camera={{ position: [0, 0, 5], fov: 45 }}
        dpr={[1, 1.75]}
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        }}
      >
        <Scene />
      </Canvas>
    </div>
  );
}
