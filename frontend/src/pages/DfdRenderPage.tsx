import { useEffect, useMemo, useRef, useState } from 'react';
import { toJpeg, toPng } from 'html-to-image';
import { getNodesBounds, getViewportForBounds, type Node } from '@xyflow/react';

import { DfdStudio } from '../components/DfdStudio';
import '../index.css';

import type { StructuredDfd } from '../types';

const SAMPLE_DFD: StructuredDfd = {
  boundaries: [{ name: 'internet' }, { name: 'internal' }],
  external_entities: [{ name: 'partenaire', boundary: '' }],
  processes: [
    { name: 'API GATEWAY', boundary: 'internet' },
    { name: 'backend', boundary: 'internal' },
  ],
  data_stores: [{ name: 'postgresql db', boundary: '' }],
  data_flows: [
    { source: 'partenaire', target: 'API GATEWAY', label: 'se connecte' },
    { source: 'API GATEWAY', target: 'backend', label: 'authentification' },
    { source: 'backend', target: 'postgresql db', label: 'stocke' },
  ],
};

function prettyJson(value: StructuredDfd) {
  return JSON.stringify(value, null, 2);
}

function parseNodeTransform(element: HTMLElement) {
  const transform = element.style.transform || window.getComputedStyle(element).transform;
  const match = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
  if (match) {
    return {
      x: Number(match[1]),
      y: Number(match[2]),
    };
  }
  return { x: 0, y: 0 };
}

declare global {
  interface Window {
    __DFD_TEST_API__?: {
      ready: boolean;
      setDiagram: (diagram: StructuredDfd) => Promise<boolean>;
      renderFromJson: (diagram: StructuredDfd, format?: 'png' | 'jpeg') => Promise<string>;
      exportCurrent: (format?: 'png' | 'jpeg') => Promise<string>;
    };
  }
}

export function DfdRenderPage() {
  const [rawJson, setRawJson] = useState(prettyJson(SAMPLE_DFD));
  const [appliedDfd, setAppliedDfd] = useState<StructuredDfd>(SAMPLE_DFD);
  const [error, setError] = useState('');
  const shellRef = useRef<HTMLDivElement | null>(null);

  const lineCount = useMemo(() => rawJson.split(/\r?\n/).length, [rawJson]);

  const applyJson = () => {
    try {
      const parsed = JSON.parse(rawJson) as StructuredDfd;
      setAppliedDfd(parsed);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'JSON invalide');
    }
  };

  const exportCurrentImage = async (format: 'png' | 'jpeg' = 'png') => {
    const viewportElement = shellRef.current?.querySelector('.react-flow__viewport') as HTMLElement | null;
    const nodeElements = Array.from(
      shellRef.current?.querySelectorAll('.react-flow__node') ?? []
    ) as HTMLElement[];
    if (!viewportElement) {
      throw new Error('DFD viewport not found.');
    }
    if (nodeElements.length === 0) {
      throw new Error('No DFD nodes found.');
    }

    shellRef.current?.classList.add('is-exporting');
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));

    try {
      const nodesForBounds = nodeElements.map((element) => {
        const position = parseNodeTransform(element);
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        return {
          id: element.dataset.id ?? crypto.randomUUID(),
          position,
          measured: { width, height },
        } as Node;
      });
      const bounds = getNodesBounds(nodesForBounds);
      const canvasWidth = Math.max(
        (shellRef.current?.querySelector('.dfd-canvas-card') as HTMLElement | null)?.clientWidth ?? 0,
        1200
      );
      const canvasHeight = Math.max(
        (shellRef.current?.querySelector('.dfd-canvas-card') as HTMLElement | null)?.clientHeight ?? 0,
        720
      );
      const paddedBounds = {
        x: bounds.x - 48,
        y: bounds.y - 48,
        width: bounds.width + 96,
        height: bounds.height + 96,
      };
      const viewport = getViewportForBounds(
        paddedBounds,
        canvasWidth,
        canvasHeight,
        0.2,
        2.5,
        0.02
      );
      const exporter = format === 'jpeg' ? toJpeg : toPng;
      return await exporter(viewportElement, {
        backgroundColor: format === 'jpeg' ? '#ffffff' : 'rgba(255,255,255,0)',
        pixelRatio: 2.5,
        cacheBust: true,
        width: canvasWidth,
        height: canvasHeight,
        style: {
          width: `${canvasWidth}px`,
          height: `${canvasHeight}px`,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
        },
      });
    } finally {
      shellRef.current?.classList.remove('is-exporting');
    }
  };

  useEffect(() => {
    window.__DFD_TEST_API__ = {
      ready: true,
      setDiagram: async (diagram: StructuredDfd) => {
        setRawJson(prettyJson(diagram));
        setAppliedDfd(diagram);
        setError('');
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        return true;
      },
      renderFromJson: async (diagram: StructuredDfd, format: 'png' | 'jpeg' = 'png') => {
        setRawJson(prettyJson(diagram));
        setAppliedDfd(diagram);
        setError('');
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        return exportCurrentImage(format);
      },
      exportCurrent: async (format: 'png' | 'jpeg' = 'png') => exportCurrentImage(format),
    };

    return () => {
      delete window.__DFD_TEST_API__;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#fffdf8_0%,#fff8ed_100%)] px-6 py-8 text-slate-900">
      <div className="mx-auto max-w-[1800px]">
        <div className="mb-6 rounded-3xl border border-slate-200 bg-white/90 px-6 py-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            Test Direct
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            Rendu DFD depuis JSON LLM sans `pytm`
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Colle ici un `dfd_json` produit par le LLM, applique-le, puis exporte l&apos;image
            depuis le studio. Cette page sert a valider le rendu direct via le composant
            frontend.
          </p>
        </div>

        <div className="grid gap-6 xl:grid-cols-[440px_minmax(0,1fr)]">
          <section className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  JSON DFD
                </p>
                <h2 className="mt-1 text-lg font-bold">Entrée brute</h2>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {lineCount} lignes
              </span>
            </div>

            <textarea
              value={rawJson}
              onChange={(event) => setRawJson(event.target.value)}
              spellCheck={false}
              className="mt-4 min-h-[620px] w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 font-mono text-[13px] leading-6 text-slate-800 outline-none focus:border-orange-300"
            />

            {error ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={applyJson}
                className="rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Appliquer le JSON
              </button>
              <button
                type="button"
                onClick={() => {
                  setRawJson(prettyJson(SAMPLE_DFD));
                  setAppliedDfd(SAMPLE_DFD);
                  setError('');
                }}
                className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Remettre l&apos;exemple
              </button>
            </div>
          </section>

          <section
            ref={shellRef}
            className="min-w-0 rounded-3xl border border-slate-200 bg-white/80 p-4 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
          >
            <DfdStudio
              value={appliedDfd}
              onChange={setAppliedDfd}
              title="Rendu direct du JSON"
              fullscreen
            />
          </section>
        </div>
      </div>
    </div>
  );
}
