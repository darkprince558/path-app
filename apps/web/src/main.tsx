import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import AppLayout from "./components/AppLayout";
import Community from "./routes/Community";
import Home from "./routes/Home";
import MyMaps from "./routes/MyMaps";
import GuestView from "./routes/GuestView";
import NotFound from "./routes/NotFound";
import Upload from "./routes/Upload";

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  {
    element: <AppLayout />,
    children: [
      { path: "/maps", element: <MyMaps /> },
      { path: "/maps/new", element: <Upload /> },
      { path: "/community", element: <Community /> },
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
    <RouterProvider router={router} />
  </StrictMode>,
);
