import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import Home from "./routes/Home";
import GuestView from "./routes/GuestView";
import NotFound from "./routes/NotFound";
import Spaces from "./routes/Spaces";
import SpaceView from "./routes/SpaceView";
import EventView from "./routes/EventView";

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/s/:shareId", element: <GuestView /> },
  { path: "/spaces", element: <Spaces /> },
  { path: "/spaces/:spaceId", element: <SpaceView /> },
  { path: "/events/:eventId", element: <EventView /> },
  { path: "*", element: <NotFound /> },
]);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
