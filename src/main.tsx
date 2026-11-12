import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import FloatingArtworkPage from "./components/FloatingArtworkPage";
import "./styles.css";
const floatingPayload = new URLSearchParams(window.location.search).get("floatingArtwork");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {floatingPayload ? <FloatingArtworkPage payload={floatingPayload} /> : <App />}
  </React.StrictMode>,
);
