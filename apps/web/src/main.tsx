import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import { AuthProvider, RequireAuth } from "./lib/auth";
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
import Spaces from "./routes/Spaces";
import SpaceView from "./routes/SpaceView";
import EventPage from "./routes/EventPage";
import Events from "./routes/Events";
import JoinEvent from "./routes/JoinEvent";
import NewEvent from "./routes/NewEvent";

const NavMeshDemo = lazy(() => import("./routes/NavMeshDemo"));

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  {
    element: <AppLayout />,
    children: [
      { element: <RequireAuth />, children: [
        { path: "/maps", element: <MyMaps /> },
        { path: "/maps/new", element: <Upload /> },
        { path: "/maps/:shareId", element: <ManageMap /> },
        { path: "/events", element: <Events /> },
        { path: "/events/new", element: <NewEvent /> },
      ] },
      // Event pages handle signed-out visitors themselves (invite links must open signed out).
      { path: "/events/:eventId", element: <EventPage /> },
      { path: "/events/:eventId/join", element: <JoinEvent /> },
      { path: "/community", element: <Community /> },
      { path: "/settings", element: <Settings /> },
    ],
  },
  { path: "/upload", element: <Navigate to="/maps/new" replace /> },
  { path: "/s/:shareId", element: <GuestView /> },
  { path: "/spaces", element: <Spaces /> },
  { path: "/spaces/:spaceId", element: <SpaceView /> },
  { path: "/navmesh-demo", element: <Suspense fallback={<p>Loading navigation demo…</p>}><NavMeshDemo /></Suspense> },
  { path: "*", element: <NotFound /> },
]);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <PreferencesProvider>
      <AuthProvider><RouterProvider router={router} /></AuthProvider>
    </PreferencesProvider>
  </StrictMode>,
);
