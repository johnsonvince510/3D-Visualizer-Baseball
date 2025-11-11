import React from 'react';
import Visualizer from './components/HawkEyeVisualizer3D';

export default function App(){
  return (
    <div>
      <div className="toolbar" style={{padding:"8px 12px", borderBottom:"1px solid #1e293b"}}>
        <h1 style={{margin:0, fontSize:18}}>Hawk‑Eye 3D Visualizer — Metrics Edition</h1>
        <p style={{margin:0, opacity:0.75, fontSize:12}}>Now with velocity/IVB/HB/extension charts + foot‑strike/release jump buttons.</p>
      </div>
      <Visualizer />
    </div>
  );
}