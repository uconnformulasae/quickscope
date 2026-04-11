import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Apply saved theme immediately to prevent flash
const saved = localStorage.getItem('quickscope-theme');
document.documentElement.classList.add(saved === 'light' ? 'light' : 'dark');

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<App />);
