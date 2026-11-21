import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import AppLayout from "./components/AppLayout";
import { PreferencesProvider } from "./lib/preferences";
import Community from "./routes/Community";
import Home from "./routes/Home";
import ManageMap from "./routes/ManageMap";
import MyMaps from "./routes/MyMaps";
import GuestView from "./routes/GuestView";
import NotFound from "./routes/NotFound";
import Settings from "./routes/Settings";
import Upload from "./routes/Upload";

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  {
    element: <AppLayout />,
    children: [
      { path: "/maps", element: <MyMaps /> },
      { path: "/maps/new", element: <Upload /> },
      { path: "/maps/:shareId", element: <ManageMap /> },
      { path: "/community", element: <Community /> },
      { path: "/settings", element: <Settings /> },
    ],
  },
  { path: "/upload", element: <Navigate to="/maps/new" replace /> },
  { path: "/s/:shareId", element: <GuestView /> },
  { path: "*", element: <NotFound /> },
]);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <PreferencesProvider>
      <RouterProvider router={router} />
    </PreferencesProvider>
  </StrictMode>,
);
