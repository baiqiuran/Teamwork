import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { PublicShare } from "./features/sharing/Sharing";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  window.location.pathname.startsWith("/share/") ? <PublicShare /> : <App />,
);
