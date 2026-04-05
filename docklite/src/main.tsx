import adapter from 'webrtc-adapter';
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

// Force global polyfill
if (typeof window !== 'undefined') {
  (window as any).RTCPeerConnection = (window as any).RTCPeerConnection || (window as any).webkitRTCPeerConnection || (window as any).mozRTCPeerConnection;
}

console.log("[Boot] WebRTC Check:", !!(window as any).RTCPeerConnection, "Browser:", adapter.browserDetails.browser);
import App from "./App";
import { RemoteProvider } from "./contexts/RemoteContext";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RemoteProvider>
      <App />
    </RemoteProvider>
  </React.StrictMode>,
);
