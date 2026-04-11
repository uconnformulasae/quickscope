import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Apply saved theme immediately to prevent flash
const savedTheme = localStorage.getItem('quickscope-theme') || 'dark';
document.documentElement.classList.add(savedTheme);

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<App />);
