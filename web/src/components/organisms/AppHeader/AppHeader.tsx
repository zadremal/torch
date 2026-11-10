// Organism: the app header — name, Dashboard and Sessions navigation, settings gear.
// Dark (g100 theme) on a light page; the name is "torch" instead of "Session debugger" (plan §9.3).
import { IconButton, Theme } from "@carbon/react";
import { Settings } from "@carbon/icons-react";
import type { MouseEvent } from "react";
import { NavLink, useNavigate } from "react-router";
import { ROUTES } from "../../../lib/routes.ts";
import styles from "./AppHeader.module.css";

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
    <Theme as="header" theme="g100" className={styles.root}>
      <span className={styles.name}>torch</span>
      <nav aria-label="Main" className={styles.nav}>
        {/* `end`: Dashboard is active only on "/", Sessions — also on session pages. */}
        <NavLink to={ROUTES.dashboard} end className={styles.link}>
          Dashboard
        </NavLink>
        <NavLink to={ROUTES.sessions} className={styles.link}>
          Sessions
        </NavLink>
      </nav>
      <IconButton kind="ghost" label="Settings" align="bottom-end" href={ROUTES.settings} onClick={openSettings}>
        <Settings />
      </IconButton>
    </Theme>
  );
}
