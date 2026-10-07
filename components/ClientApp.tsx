'use client';
import dynamic from 'next/dynamic';

/** The whole experience is client-only (WebGL, rAF simulation, local state). */
const App = dynamic(() => import('./App'), { ssr: false, loading: () => <div className="loader"><div className="loader-box"><div className="loader-title">INITIALIZING FAB</div></div></div> });

export default function ClientApp() {
  return <App />;
}
