import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";

import { SkillsSettingsPanel } from "../components/settings/SkillsSettings";

function SettingsSkillsRoute() {
  const { pathname } = useLocation();
  if (pathname !== "/settings/skills") return <Outlet />;
  return <SkillsSettingsPanel />;
}

export const Route = createFileRoute("/settings/skills")({
  component: SettingsSkillsRoute,
});
