import React from "react";
import { createRoot } from "react-dom/client";
import App from "./ui/App.jsx";
import { PrivyRoot } from "./ui/privy.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
    <React.StrictMode>
        <PrivyRoot>
            <App />
        </PrivyRoot>
    </React.StrictMode>,
);
