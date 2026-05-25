import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export function AuthScene() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.z = 8;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const particleCount = 420;
    const positions = new Float32Array(particleCount * 3);
    const basePositions = new Float32Array(particleCount * 3);

    for (let index = 0; index < particleCount; index += 1) {
      const stride = index * 3;
      positions[stride] = (Math.random() - 0.5) * 15;
      positions[stride + 1] = (Math.random() - 0.5) * 10;
      positions[stride + 2] = (Math.random() - 0.5) * 6;
      basePositions[stride] = positions[stride];
      basePositions[stride + 1] = positions[stride + 1];
      basePositions[stride + 2] = positions[stride + 2];
    }

    const particlesGeometry = new THREE.BufferGeometry();
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const particlesMaterial = new THREE.PointsMaterial({
      color: 0xfb923c,
      size: 0.072,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const particles = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particles);

    const glowGeometry = new THREE.BufferGeometry();
    const glowPositions = new Float32Array([
      -3.8, 2.2, -1.6,
      3.9, -1.4, -1.8,
      0.4, 3.1, -2.4,
    ]);
    glowGeometry.setAttribute('position', new THREE.BufferAttribute(glowPositions, 3));

    const glowMaterial = new THREE.PointsMaterial({
      color: 0xffedd5,
      size: 0.35,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const glows = new THREE.Points(glowGeometry, glowMaterial);
    scene.add(glows);

    const clock = new THREE.Clock();

    const handleResize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };

    let frameId = 0;
    const animate = () => {
      const elapsed = clock.getElapsedTime();
      const attribute = particlesGeometry.getAttribute('position') as any;

      for (let index = 0; index < particleCount; index += 1) {
        const stride = index * 3;
        const baseX = basePositions[stride];
        const baseY = basePositions[stride + 1];
        const baseZ = basePositions[stride + 2];
        const offsetY = Math.sin(elapsed * 0.42 + index * 0.19) * 0.18;
        const offsetX = Math.cos(elapsed * 0.27 + index * 0.13) * 0.12;
        const offsetZ = Math.sin(elapsed * 0.31 + index * 0.11) * 0.08;
        attribute.setX(index, baseX + offsetX);
        attribute.setY(index, baseY + offsetY);
        attribute.setZ(index, baseZ + offsetZ);
      }

      attribute.needsUpdate = true;
      particles.rotation.z = elapsed * 0.016;
      glows.rotation.z = -elapsed * 0.025;

      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };

    window.addEventListener('resize', handleResize);
    animate();

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleResize);
      particlesGeometry.dispose();
      particlesMaterial.dispose();
      glowGeometry.dispose();
      glowMaterial.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div ref={mountRef} className="absolute inset-0" aria-hidden="true" />;
}
