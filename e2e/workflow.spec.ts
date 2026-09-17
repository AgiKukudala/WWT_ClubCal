import { type Browser, expect, type Page, test } from "@playwright/test";

const PASSWORD = "clubcal-demo-password";
const TZ = "America/Chicago";

async function signIn(browser: Browser, email: string, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("dialog", (d) => {
    throw new Error(`Unexpected dialog: ${d.message()}`);
  });
  await page.goto("/login");
  await page.getByLabel("School email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
  return page;
}

/** Local date/time (in TZ) of an instant, for form inputs. */
function localParts(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

test("organizer submits → admin approves → student RSVPs → reminder → cancellation", async ({ browser }) => {
  // Start ~62 minutes from now so the 1-hour reminder becomes due within about two minutes.
  const start = new Date(Math.ceil((Date.now() + 62 * 60_000) / 60_000) * 60_000);
  const { date, time } = localParts(start);
  const title = `E2E <img src=x onerror=alert(1)> meetup ${Date.now()}`;

  // 1. Organizer submits an event.
  const organizer = await signIn(browser, "rivera@demo.clubcal.test");
  await organizer.getByRole("link", { name: "New event" }).click();
  await expect(organizer.getByRole("heading", { name: "New event", level: 1 })).toBeVisible();
  await organizer.getByLabel("Club", { exact: true }).selectOption({ label: "Robotics Club (demo)" });
  await organizer.getByLabel("Title").fill(title);
  await organizer.getByLabel("Description").fill("Bring a laptop.\nSecond line.");
  await organizer.getByLabel("Category").fill("STEM");
  await organizer.getByLabel("Date", { exact: true }).fill(date);
  await organizer.getByLabel("Start time").fill(time);
  await organizer.getByLabel("Duration").selectOption("45");
  await organizer.getByLabel("Attendance limit").fill("5");
  await organizer.getByRole("button", { name: "Submit for approval" }).click();
  await expect(organizer.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(organizer.getByText("Awaiting approval").first()).toBeVisible();
  const eventUrl = organizer.url();

  // A student cannot see it yet (direct URL → not found).
  const student = await signIn(browser, "sam@demo.clubcal.test", { width: 390, height: 844 });
  await student.goto(eventUrl);
  await expect(student.getByText("Not found")).toBeVisible();

  // 2. Administrator approves it from the approval queue.
  const admin = await signIn(browser, "admin@demo.clubcal.test");
  await admin.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /^Admin/ }).click();
  const row = admin.locator(".approval-list li", { hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(admin.getByText("Approved and published.")).toBeVisible();
  await expect(row).toHaveCount(0);

  // 3. The student (separate session, mobile viewport) sees it in the shared calendar.
  await student.goto("/?view=agenda");
  const card = student.locator(".event-card", { hasText: title });
  await expect(card).toBeVisible({ timeout: 30_000 });
  // The HTML-looking title is shown literally; no <img> was injected.
  await expect(student.locator(".event-card img")).toHaveCount(0);
  await card.getByRole("link", { name: title }).click();
  await expect(student.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(student.getByText("Bring a laptop.")).toBeVisible();

  // 4. Student RSVPs.
  await student.getByRole("button", { name: "Going", exact: true }).click();
  await expect(student.getByText("You're going!")).toBeVisible();
  await expect(student.getByText("1 of 5 spots taken")).toBeVisible();

  // The organizer sees the attendee.
  await organizer.reload();
  await expect(organizer.locator(".attendees")).toContainText("Sam Student (demo)");

  // The .ics download works and contains the event.
  const ics = await student.request.get(`${eventUrl.replace(/.*\/events\//, "/api/occurrences/")}/ics`);
  expect(ics.status()).toBe(200);
  expect(await ics.text()).toContain("BEGIN:VEVENT");

  // 5. The worker delivers the 1-hour reminder (no browser involvement needed).
  await student.goto("/notifications");
  await expect(async () => {
    await student.reload();
    await expect(student.locator(".notifications .link-like", { hasText: `Starting in 1 hour: ${title}` })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 4 * 60_000, intervals: [5_000] });
  // On a phone the nav is collapsed; the menu button carries the unread count.
  await expect(student.getByRole("button", { name: /Menu, \d+ unread notifications/ })).toBeVisible();

  // 6. Organizer cancels; the student's view updates.
  await organizer.getByRole("button", { name: "Cancel event" }).click();
  const dialog = organizer.getByRole("dialog");
  await dialog.getByLabel("Reason (shown to attendees)").fill("Presenter is sick");
  await dialog.getByRole("button", { name: "Cancel event" }).click();
  await expect(organizer.getByText(/Cancelled 1 occurrence/)).toBeVisible();

  await student.goto(eventUrl);
  await expect(student.getByText("This event was cancelled: Presenter is sick")).toBeVisible();
  await student.goto("/notifications");
  await expect(student.locator(".notifications .link-like", { hasText: `Cancelled: ${title}` })).toBeVisible({ timeout: 30_000 });
  await student.goto("/?view=agenda");
  await expect(student.locator(".event-card.is-cancelled", { hasText: title })).toBeVisible();
});

test("an organizer cannot manage another club's events and students see no admin tools", async ({ browser }) => {
  const patel = await signIn(browser, "patel@demo.clubcal.test");
  await patel.goto("/?view=agenda");
  await patel.locator(".event-card", { hasText: "Robotics build night" }).first().getByRole("link").first().click();
  await expect(patel.getByRole("heading", { name: "Robotics build night", level: 1 })).toBeVisible();
  await expect(patel.getByRole("heading", { name: "Manage" })).toHaveCount(0);
  const res = await patel.request.put(`/api/occurrences/${patel.url().split("/").pop()}/rsvp`, { data: { response: "going" } });
  expect(res.status()).toBe(403); // no CSRF token from a raw request

  const student = await signIn(browser, "jordan@demo.clubcal.test");
  await expect(student.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /^Admin/ })).toHaveCount(0);
  await student.goto("/admin");
  await expect(student.getByText("You don't have access to this page.")).toBeVisible();
});

test("conflicting room booking shows an understandable explanation", async ({ browser }) => {
  const admin = await signIn(browser, "admin@demo.clubcal.test");
  // Find the first robotics build night and try to book the same room at the same time.
  const occ = await admin.request.get("/api/occurrences?" + new URLSearchParams({ from: new Date().toISOString(), to: new Date(Date.now() + 30 * 86400000).toISOString(), q: "Robotics build night" }));
  const first = (await occ.json()).items.find((i: { status: string }) => i.status === "approved");
  const { date, time } = localParts(new Date(first.startsAt));
  await admin.goto("/events/new");
  await expect(admin.getByRole("heading", { name: "New event", level: 1 })).toBeVisible();
  await admin.getByLabel("Title").fill("Double booking attempt");
  await admin.getByLabel("Category").fill("Test");
  await admin.getByLabel("Date", { exact: true }).fill(date);
  await admin.getByLabel("Start time").fill(time);
  await admin.getByLabel("Room", { exact: true }).selectOption({ label: "Makerspace Lab (demo) (seats 20)" });
  await admin.getByRole("button", { name: "Publish" }).click();
  await expect(admin.getByRole("alert")).toContainText("Makerspace Lab (demo) is already reserved");
  await expect(admin.getByRole("heading", { name: "New event" })).toBeVisible();
});
