import type { Plugin } from "obsidian";

export const DASHBOARD_PLUGIN_ID = "okf-workspace-dashboard";
export const DASHBOARD_COMMAND_ID = "open-dashboard";
export const DASHBOARD_RIBBON_ICON = "brain-circuit";
export const DASHBOARD_RIBBON_TITLE = "打开工作台";
// Obsidian keys ribbon visibility by the registration title. Keep the old key,
// then update the accessible tooltip without resetting the user's visibility.
export const DASHBOARD_RIBBON_REGISTRATION_TITLE = "打开 Dashboard";
export const DASHBOARD_RIBBON_STORAGE_KEY = `${DASHBOARD_PLUGIN_ID}:${DASHBOARD_RIBBON_REGISTRATION_TITLE}`;

type DashboardRibbonHost = Pick<Plugin, "addRibbonIcon">;

/**
 * Register the stable, primary Dashboard entry point in Obsidian's left ribbon.
 *
 * Obsidian persists ribbon visibility by plugin id and tooltip title, so both are
 * intentionally centralized and covered by tests. The marker also gives support
 * tooling a stable way to distinguish this action from the Dashboard view icon.
 */
export function registerDashboardRibbon(
  host: DashboardRibbonHost,
  openDashboard: () => void,
): HTMLElement {
  const ribbon = host.addRibbonIcon(
    DASHBOARD_RIBBON_ICON,
    DASHBOARD_RIBBON_REGISTRATION_TITLE,
    openDashboard,
  );
  ribbon.classList.add("okf-workspace-dashboard-ribbon");
  ribbon.dataset.okfEntrypoint = "dashboard";
  ribbon.setAttribute("aria-label", DASHBOARD_RIBBON_TITLE);
  return ribbon;
}
