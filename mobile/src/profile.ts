// The Profile tab: who is signed in, the badges' look (as on the website's
// profile page, saved with the account), and signing out. The rest of the
// profile (ratings, privacy, storage, deleting the account) stays on the
// website.
import { badgeIcons, badgeShine, ICONS, setBadgePrefs, SHINES, type BadgeIcons, type BadgeShine } from "@web/badgePrefs";
import { escapeHtml } from "@web/layout";
import { PIECES, pieceBadgeHtml, TIER_LABELS, TIERS } from "@web/scoreTiers";

import { me } from "./api";
import { shell } from "./lists";

function choices<T extends string>(name: string, options: { value: T; label: string; title: string }[], current: T): string {
  return options
    .map((o) => `<button class="chip" type="button" data-pref="${name}" data-value="${o.value}" title="${escapeHtml(o.title)}" aria-pressed="${o.value === current}">${o.label}</button>`)
    .join("");
}

// Every tier with the king, then every piece in the top tier.
function preview(): string {
  const top = TIERS[0].tier;
  const tiers = [...TIERS.map((t) => t.tier), "none" as const]
    .map((tier) => `<span title="${TIER_LABELS[tier]}">${pieceBadgeHtml(tier, "", "king")}</span>`)
    .join("");
  const pieces = PIECES.map((p) => `<span title="${TIER_LABELS[top]} ${p.label}">${pieceBadgeHtml(top, "", p.piece)}</span>`).join("");
  return `<div class="profile__preview" aria-label="Preview of the badges">
    <div class="profile__badges">${tiers}</div>
    <div class="profile__badges">${pieces}</div>
  </div>`;
}

function appearance(): string {
  return `<section class="stats__card profile__prefs">
    <h3>Badges</h3>
    <p class="stats__note">Their shine is the expected score's tier, their piece the expected evaluation's.
      Saved with your account, on the website too.</p>
    <h4 class="profile__label">Shine</h4>
    <div class="profile__choices">${choices("shine", SHINES, badgeShine())}</div>
    <h4 class="profile__label">Icons</h4>
    <div class="profile__choices">${choices("icons", ICONS, badgeIcons())}</div>
    ${preview()}
    <p class="stats__warning" id="profile-status" role="status" hidden></p>
  </section>`;
}

/** Returns what to undo on leaving: the choices' listener. */
export async function renderProfile(app: HTMLElement): Promise<() => void> {
  const account = await me();
  const name = account.displayName ?? "";
  const draw = () => {
    app.innerHTML = shell("profile", "Profile", "", `
      <div class="stats">
        <h2 class="stats__name">${escapeHtml(name)}</h2>
        ${appearance()}
        <a class="button" href="/profile.html">Full profile on website</a>
        <a class="button" href="/auth/logout?next=${encodeURIComponent("/m/")}">Log out</a>
      </div>
    `);
  };
  draw();
  const choose = async (e: Event) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-pref]");
    if (!button) return;
    const value = button.dataset.value!;
    const saved = setBadgePrefs(button.dataset.pref === "shine" ? { shine: value as BadgeShine } : { icons: value as BadgeIcons });
    draw();
    const ok = await saved;
    const status = app.querySelector<HTMLElement>("#profile-status");
    if (status && !ok) {
      status.hidden = false;
      status.textContent = "Shown on this phone, but not saved with your account. Please try again.";
    }
  };
  app.addEventListener("click", choose);
  return () => app.removeEventListener("click", choose);
}
