import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// QuickScope is dark-first — apply dark class immediately to prevent flash
document.documentElement.classList.add('dark');

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<App />);
