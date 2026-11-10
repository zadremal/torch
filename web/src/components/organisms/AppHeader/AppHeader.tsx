// Organism: the app header — name, Dashboard and Sessions navigation, settings gear.
// Dark (g100 theme) on a light page; the name is "torch" instead of "Session debugger" (plan §9.3).
import { IconButton, Theme } from "@carbon/react";
import { Settings } from "@carbon/icons-react";
import type { MouseEvent } from "react";
import { NavLink, useNavigate } from "react-router";
import { ROUTES } from "../../../lib/routes.ts";
import "./AppHeader.scss";

export function AppHeader() {
  const navigate = useNavigate();

  // The gear is a link: it opens in a new tab by ordinary browser means,
  // and a plain click navigates without reloading the page.
  const openSettings = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(ROUTES.settings);
  };

  return (
    <Theme as="header" theme="g100" className="torch-header">
      <span className="torch-header__name">torch</span>
      <nav aria-label="Main" className="torch-header__nav">
        {/* `end`: Dashboard is active only on "/", Sessions — also on session pages. */}
        <NavLink to={ROUTES.dashboard} end className="torch-header__link">
          Dashboard
        </NavLink>
        <NavLink to={ROUTES.sessions} className="torch-header__link">
          Sessions
        </NavLink>
      </nav>
      <IconButton kind="ghost" label="Settings" align="bottom-end" href={ROUTES.settings} onClick={openSettings}>
        <Settings />
      </IconButton>
    </Theme>
  );
}
