"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type CarPosition = { x: number; y: number; angle: number };

const MODEL_ROOT = "/models/tesla-roadster";
const MODEL_FILES = ["roadster_02_red.glb", "roadster_03_blue.glb"];

export function RoadsterCars({ positions, onReady }: { positions: CarPosition[]; onReady: (ready: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carsRef = useRef<THREE.Group[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      return; // The SVG cars remain visible when WebGL is unavailable.
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x34404a, 2.3));
    const sun = new THREE.DirectionalLight(0xffffff, 2.8);
    sun.position.set(-180, 350, -260);
    scene.add(sun);
    const camera = new THREE.OrthographicCamera(-430, 430, 237.5, -237.5, 0.1, 1000);
    camera.position.set(0, 500, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);

    const draw = () => renderer.render(scene, camera);
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width && bounds.height) renderer.setSize(bounds.width, bounds.height, false);
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    canvas.addEventListener("roadster-position-change", draw);

    const loader = new GLTFLoader();
    Promise.all(MODEL_FILES.map(file => loader.loadAsync(`${MODEL_ROOT}/${file}`)))
      .then(models => {
        if (disposed) return;
        const cars = models.map(({ scene: model }) => {
          const car = new THREE.Group();
          model.scale.setScalar(10);
          car.add(model);
          scene.add(car);
          return car;
        });
        carsRef.current = cars;
        // Position the models before hiding the SVG fallback.
        positions.forEach((position, i) => {
          if (!cars[i]) return;
          cars[i].position.set(position.x - 430, 1, position.y - 237.5);
          cars[i].rotation.y = -Math.PI / 2 - position.angle * Math.PI / 180;
        });
        resize();
        onReady(true);
      })
      .catch(() => { /* Keep the SVG fallback if a model cannot load. */ });

    return () => {
      disposed = true;
      observer.disconnect();
      canvas.removeEventListener("roadster-position-change", draw);
      carsRef.current = [];
      scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => material.dispose());
      });
      renderer.dispose();
      onReady(false);
    };
    // The scene is created once; the current positions are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    positions.forEach((position, i) => {
      const car = carsRef.current[i];
      if (!car) return;
      car.position.set(position.x - 430, 1, position.y - 237.5);
      car.rotation.y = -Math.PI / 2 - position.angle * Math.PI / 180;
    });
    if (carsRef.current.length) {
      const canvas = canvasRef.current;
      canvas?.dispatchEvent(new Event("roadster-position-change"));
    }
  }, [positions]);

  return <canvas ref={canvasRef} className="roadster-canvas" aria-hidden="true" />;
}
