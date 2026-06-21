import { Router } from "express";
import { db } from "@workspace/db";
import { attendance, locationPings, settings, sites, technicianLocationHistory, technicianLocations, users } from "@workspace/db/schema";
import { eq, desc, and, gte, lte, lt, inArray, isNull } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth.js";
import { requireTechnician } from "../middleware/auth.js";
import { randomUUID } from "crypto";

const router = Router();

interface AttendanceSettings {
  deadlineHHMM: string;
  shiftEndHHMM: string;
  timezone: string;
}

async function getAttendanceSettings(): Promise<AttendanceSettings> {
  const rows = await db.select().from(settings)
    .where(inArray(settings.key, ["attendance_checkin_deadline", "attendance_shift_end", "timezone"]));
  const get = (key: string, def: string) => rows.find(r => r.key === key)?.value ?? def;
  return {
    deadlineHHMM: get("attendance_checkin_deadline", "08:00"),
    shiftEndHHMM: get("attendance_shift_end", "18:00"),
    timezone: get("timezone", "Asia/Karachi"),
  };
}

// Convert a UTC Date to minutes-since-midnight in the configured timezone using Intl API
function toLocalMins(d: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    let h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
    const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
    if (h === 24) h = 0; // Intl may return 24 for midnight
    return h * 60 + m;
  } catch {
    // Fallback: UTC+5 (Asia/Karachi)
    const pkt = new Date(d.getTime() + 5 * 60 * 60 * 1000);
    return pkt.getUTCHours() * 60 + pkt.getUTCMinutes();
  }
}

// Return local HHMM string in the configured timezone
function toLocalHHMM(d: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    let h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
    const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
    if (h === 24) h = 0;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  } catch {
    const pkt = new Date(d.getTime() + 5 * 60 * 60 * 1000);
    return `${String(pkt.getUTCHours()).padStart(2, "0")}:${String(pkt.getUTCMinutes()).padStart(2, "0")}`;
  }
}

// Compute start/end of the current local calendar day (midnight–midnight) as UTC Date objects.
// Uses noon-UTC offset trick to avoid DST-at-midnight edge cases.
function getLocalDayBoundsUTC(timezone: string): { todayUTC: Date; tomorrowUTC: Date } {
  try {
    const now = new Date();
    // Get the local date string (YYYY-MM-DD) in the target timezone
    const localDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
    const [year, month, day] = localDateStr.split("-").map(Number) as [number, number, number];

    // Find UTC offset at noon on this local date (noon avoids DST transitions at midnight)
    const noonUTC = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const noonParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(noonUTC);
    let localNoonH = parseInt(noonParts.find(p => p.type === "hour")?.value ?? "12", 10);
    const localNoonM = parseInt(noonParts.find(p => p.type === "minute")?.value ?? "0", 10);
    if (localNoonH === 24) localNoonH = 0;
    const offsetMins = localNoonH * 60 + localNoonM - 12 * 60; // e.g. PKT UTC+5 → 300

    // Local midnight = UTC midnight of that date shifted back by the offset
    const utcMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    const todayUTC = new Date(utcMidnight.getTime() - offsetMins * 60 * 1000);
    const tomorrowUTC = new Date(todayUTC.getTime() + 24 * 60 * 60 * 1000);
    return { todayUTC, tomorrowUTC };
  } catch {
    // Fallback: UTC day boundaries
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    return { todayUTC: today, tomorrowUTC: tomorrow };
  }
}

function calcStats(
  checkIn: Date,
  checkOut: Date | null,
  deadlineHHMM: string,
  shiftEndHHMM: string,
  timezone: string
) {
  const [dlH = 8, dlM = 0] = deadlineHHMM.split(":").map(Number);
  const deadlineMins = dlH * 60 + dlM;
  const checkInMins = toLocalMins(checkIn, timezone);
  const isLate = checkInMins > deadlineMins;

  let totalHours: number | null = null;
  let overtimeHours: number | null = null;
  if (checkOut) {
    totalHours = (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60);
    const [seH = 18, seM = 0] = shiftEndHHMM.split(":").map(Number);
    const shiftEndMins = seH * 60 + seM;
    const checkOutMins = toLocalMins(checkOut, timezone);
    overtimeHours = Math.max(0, (checkOutMins - shiftEndMins) / 60);
  }
  return { isLate, totalHours, overtimeHours };
}

async function formatRecord(row: typeof attendance.$inferSelect, attSettings: AttendanceSettings) {
  const tech = await db.select({ name: users.name }).from(users).where(eq(users.id, row.technicianId)).limit(1);
  let siteName: string | null = null;
  if (row.siteId) {
    const s = await db.select({ name: sites.name }).from(sites).where(eq(sites.id, row.siteId)).limit(1);
    siteName = s[0]?.name ?? null;
  }
  const { isLate, totalHours, overtimeHours } = calcStats(
    row.checkInAt,
    row.checkOutAt ?? null,
    attSettings.deadlineHHMM,
    attSettings.shiftEndHHMM,
    attSettings.timezone
  );
  return {
    id: row.id,
    technicianId: row.technicianId,
    technicianName: tech[0]?.name ?? "Unknown",
    siteId: row.siteId,
    siteName,
    selfieUrl: row.selfieUrl,
    sitePhotoUrl: row.sitePhotoUrl,
    latitude: row.latitude,
    longitude: row.longitude,
    locationAddress: row.locationAddress,
    checkInAt: row.checkInAt.toISOString(),
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    totalHours,
    overtimeHours,
    isLate,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

// POST /attendance/checkin — technician check-in
router.post("/attendance/checkin", requireTechnician, async (req, res) => {
  const { selfieUrl, sitePhotoUrl, latitude, longitude, locationAddress, siteId, notes } = req.body as {
    selfieUrl?: string;
    sitePhotoUrl?: string;
    latitude?: string;
    longitude?: string;
    locationAddress?: string;
    siteId?: string;
    notes?: string;
  };

  const techId = req.auth!.userId;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const existing = await db.select({ id: attendance.id })
    .from(attendance)
    .where(and(
      eq(attendance.technicianId, techId),
      gte(attendance.checkInAt, today),
      lt(attendance.checkInAt, tomorrow)
    ))
    .limit(1);

  if (existing.length > 0) {
    res.status(400).json({ error: "Already checked in today" });
    return;
  }

  const id = randomUUID();
  const [row] = await db.insert(attendance).values({
    id,
    technicianId: techId,
    siteId: siteId ?? null,
    selfieUrl: selfieUrl ?? null,
    sitePhotoUrl: sitePhotoUrl ?? null,
    latitude: latitude ?? null,
    longitude: longitude ?? null,
    locationAddress: locationAddress ?? null,
    notes: notes ?? null,
    checkInAt: new Date(),
  }).returning();

  const attSettings = await getAttendanceSettings();
  res.json(await formatRecord(row, attSettings));
});

// POST /attendance/:id/checkout
router.post("/attendance/:id/checkout", requireTechnician, async (req, res) => {
  const id = req.params.id as string;
  const techId = req.auth!.userId;

  const [row] = await db.select().from(attendance)
    .where(and(eq(attendance.id, id), eq(attendance.technicianId, techId)))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Attendance record not found" });
    return;
  }
  if (row.checkOutAt) {
    res.status(400).json({ error: "Already checked out" });
    return;
  }

  const [updated] = await db.update(attendance)
    .set({ checkOutAt: new Date() })
    .where(eq(attendance.id, id))
    .returning();

  const attSettings = await getAttendanceSettings();
  res.json(await formatRecord(updated, attSettings));
});

// GET /attendance — admin: all records with optional date + technicianId filter
router.get("/attendance", requireAdmin, async (req, res) => {
  const { date, technicianId } = req.query as { date?: string; technicianId?: string };

  const conditions = [];
  if (date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    conditions.push(gte(attendance.checkInAt, d));
    conditions.push(lt(attendance.checkInAt, next));
  }
  if (technicianId) {
    conditions.push(eq(attendance.technicianId, technicianId));
  }

  const rows = conditions.length > 0
    ? await db.select().from(attendance).where(and(...conditions)).orderBy(desc(attendance.checkInAt))
    : await db.select().from(attendance).orderBy(desc(attendance.checkInAt));

  const attSettings = await getAttendanceSettings();
  const records = await Promise.all(rows.map(r => formatRecord(r, attSettings)));
  res.json(records);
});

// GET /attendance/my — technician's own history
router.get("/attendance/my", requireTechnician, async (req, res) => {
  const techId = req.auth!.userId;
  const rows = await db.select().from(attendance)
    .where(eq(attendance.technicianId, techId))
    .orderBy(desc(attendance.checkInAt))
    .limit(60);
  const attSettings = await getAttendanceSettings();
  const records = await Promise.all(rows.map(r => formatRecord(r, attSettings)));
  res.json(records);
});

// POST /attendance/location-ping — technician sends GPS ping while checked in
router.post("/attendance/location-ping", requireTechnician, async (req, res) => {
  const { attendanceId, latitude, longitude, address } = req.body as {
    attendanceId: string;
    latitude: string;
    longitude: string;
    address?: string | null;
  };

  if (!attendanceId || !latitude || !longitude) {
    res.status(400).json({ error: "attendanceId, latitude and longitude are required" });
    return;
  }

  const techId = req.auth!.userId;

  const [att] = await db.select({ id: attendance.id, checkOutAt: attendance.checkOutAt })
    .from(attendance)
    .where(and(eq(attendance.id, attendanceId), eq(attendance.technicianId, techId)))
    .limit(1);

  if (!att) {
    res.status(404).json({ error: "Attendance record not found" });
    return;
  }
  if (att.checkOutAt) {
    res.status(400).json({ error: "Already checked out — cannot send location ping" });
    return;
  }

  const id = randomUUID();
  const [ping] = await db.insert(locationPings).values({
    id,
    attendanceId,
    technicianId: techId,
    latitude,
    longitude,
    address: address ?? null,
    recordedAt: new Date(),
  }).returning();

  res.status(201).json({
    id: ping.id,
    attendanceId: ping.attendanceId,
    technicianId: ping.technicianId,
    latitude: ping.latitude,
    longitude: ping.longitude,
    address: ping.address,
    recordedAt: ping.recordedAt.toISOString(),
  });
});

// GET /attendance/today — technician's today record
router.get("/attendance/today", requireTechnician, async (req, res) => {
  const techId = req.auth!.userId;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const [row] = await db.select().from(attendance)
    .where(and(
      eq(attendance.technicianId, techId),
      gte(attendance.checkInAt, today),
      lt(attendance.checkInAt, tomorrow)
    ))
    .limit(1);

  const attSettings = await getAttendanceSettings();
  res.json({ record: row ? await formatRecord(row, attSettings) : null });
});

// GET /attendance/absent-today — admin: technicians who have not checked in today (gated by alert time)
router.get("/attendance/absent-today", requireAdmin, async (req, res) => {
  // Only return absent list after the configured alert time (in configured timezone)
  const settingRows = await db.select().from(settings)
    .where(inArray(settings.key, ["attendance_absent_alert_time", "timezone"]));
  const alertTime = settingRows.find(r => r.key === "attendance_absent_alert_time")?.value ?? "09:00";
  const timezone = settingRows.find(r => r.key === "timezone")?.value ?? "Asia/Karachi";
  const now = new Date();
  const currentHHMM = toLocalHHMM(now, timezone);
  if (currentHHMM < alertTime) {
    res.json([]);
    return;
  }

  const { todayUTC, tomorrowUTC } = getLocalDayBoundsUTC(timezone);

  const technicians = await db
    .select({ id: users.id, name: users.name, phone: users.phone })
    .from(users)
    .where(and(eq(users.role, "technician"), eq(users.status, "approved")));

  if (technicians.length === 0) {
    res.json([]);
    return;
  }

  const todayCheckins = await db
    .select({ technicianId: attendance.technicianId })
    .from(attendance)
    .where(and(gte(attendance.checkInAt, todayUTC), lt(attendance.checkInAt, tomorrowUTC)));

  const checkedInIds = new Set(todayCheckins.map(r => r.technicianId));
  const absent = technicians.filter(t => !checkedInIds.has(t.id));

  res.json(absent.map(t => ({ id: t.id, name: t.name, phone: t.phone })));
});

// PATCH /attendance/:id — admin edit check-in or check-out time
router.patch("/attendance/:id", requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  const { checkInAt, checkOutAt, notes } = req.body as {
    checkInAt?: string;
    checkOutAt?: string | null;
    notes?: string | null;
  };

  const [existing] = await db.select().from(attendance).where(eq(attendance.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Attendance record not found" });
    return;
  }

  const updates: Partial<typeof attendance.$inferInsert> = {};
  if (checkInAt !== undefined) {
    const d = new Date(checkInAt);
    if (isNaN(d.getTime())) { res.status(400).json({ error: "Invalid checkInAt" }); return; }
    updates.checkInAt = d;
  }
  if (checkOutAt !== undefined) {
    if (checkOutAt === null) {
      updates.checkOutAt = null;
    } else {
      const d = new Date(checkOutAt);
      if (isNaN(d.getTime())) { res.status(400).json({ error: "Invalid checkOutAt" }); return; }
      updates.checkOutAt = d;
    }
  }
  if (notes !== undefined) updates.notes = notes;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [updated] = await db.update(attendance).set(updates).where(eq(attendance.id, id)).returning();
  const attSettings = await getAttendanceSettings();
  res.json(await formatRecord(updated, attSettings));
});

// POST /attendance/manual — admin manually adds an attendance entry
router.post("/attendance/manual", requireAdmin, async (req, res) => {
  const { technicianId, checkInAt, checkOutAt, notes } = req.body as {
    technicianId?: string;
    checkInAt?: string;
    checkOutAt?: string | null;
    notes?: string | null;
  };

  if (!technicianId || !checkInAt) {
    res.status(400).json({ error: "technicianId and checkInAt are required" });
    return;
  }

  const checkInDate = new Date(checkInAt);
  if (isNaN(checkInDate.getTime())) { res.status(400).json({ error: "Invalid checkInAt" }); return; }

  let checkOutDate: Date | null = null;
  if (checkOutAt) {
    checkOutDate = new Date(checkOutAt);
    if (isNaN(checkOutDate.getTime())) { res.status(400).json({ error: "Invalid checkOutAt" }); return; }
  }

  const [tech] = await db.select({ id: users.id }).from(users).where(eq(users.id, technicianId)).limit(1);
  if (!tech) { res.status(400).json({ error: "Technician not found" }); return; }

  const [row] = await db.insert(attendance).values({
    id: randomUUID(),
    technicianId,
    checkInAt: checkInDate,
    checkOutAt: checkOutDate,
    notes: notes ?? null,
  }).returning();

  const attSettings = await getAttendanceSettings();
  res.status(201).json(await formatRecord(row, attSettings));
});

// POST /technician-locations/ping — always-on ping (no attendanceId required)
router.post("/technician-locations/ping", requireTechnician, async (req, res) => {
  const { latitude, longitude, recordedAt } = req.body as {
    latitude: string;
    longitude: string;
    recordedAt?: string | null;
  };
  if (!latitude || !longitude) {
    res.status(400).json({ error: "latitude and longitude are required" });
    return;
  }
  const technicianId = req.auth!.userId;
  const now = new Date();
  const pingTime = recordedAt ? new Date(recordedAt) : now;
  const safePingTime = isNaN(pingTime.getTime()) ? now : pingTime;

  await db
    .insert(technicianLocations)
    .values({ technicianId, latitude, longitude, address: null, updatedAt: now })
    .onConflictDoUpdate({
      target: technicianLocations.technicianId,
      set: { latitude, longitude, address: null, updatedAt: now },
    });

  await db.insert(technicianLocationHistory).values({
    id: randomUUID(),
    technicianId,
    latitude,
    longitude,
    recordedAt: safePingTime,
    receivedAt: now,
  });

  res.json({ ok: true });
});

// GET /technician-locations/trail — admin: ordered pings for a technician on a given date
router.get("/technician-locations/trail", requireAdmin, async (req, res) => {
  const userId = req.query.userId as string;
  const dateStr = req.query.date as string | undefined;

  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  const targetDate = dateStr ? new Date(dateStr) : new Date();
  if (isNaN(targetDate.getTime())) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }

  const dayStart = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate(),
    0, 0, 0, 0
  );
  const dayEnd = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate(),
    23, 59, 59, 999
  );

  const pings = await db
    .select()
    .from(technicianLocationHistory)
    .where(
      and(
        eq(technicianLocationHistory.technicianId, userId),
        gte(technicianLocationHistory.recordedAt, dayStart),
        lte(technicianLocationHistory.recordedAt, dayEnd)
      )
    )
    .orderBy(technicianLocationHistory.recordedAt);

  res.json(
    pings.map((p) => ({
      id: p.id,
      technicianId: p.technicianId,
      latitude: p.latitude,
      longitude: p.longitude,
      recordedAt: p.recordedAt.toISOString(),
      receivedAt: p.receivedAt.toISOString(),
    }))
  );
});

// POST /technician-locations — technician: upsert latest location
router.post("/technician-locations", requireTechnician, async (req, res) => {
  const { attendanceId, latitude, longitude, address } = req.body as {
    attendanceId: string;
    latitude: string;
    longitude: string;
    address?: string | null;
  };
  if (!attendanceId || !latitude || !longitude) {
    res.status(400).json({ error: "attendanceId, latitude and longitude are required" });
    return;
  }
  const technicianId = req.auth!.userId;
  const now = new Date();

  // Validate: attendanceId must belong to this technician and be currently active
  const [attRow] = await db
    .select({ id: attendance.id, checkOutAt: attendance.checkOutAt })
    .from(attendance)
    .where(and(eq(attendance.id, attendanceId), eq(attendance.technicianId, technicianId)));
  if (!attRow) {
    res.status(403).json({ error: "Attendance record not found or does not belong to you" });
    return;
  }
  if (attRow.checkOutAt) {
    res.status(400).json({ error: "Cannot update location for a completed attendance session" });
    return;
  }

  // Upsert latest location (technician_locations) — one row per technician
  await db
    .insert(technicianLocations)
    .values({ technicianId, attendanceId, latitude, longitude, address: address ?? null, updatedAt: now })
    .onConflictDoUpdate({
      target: technicianLocations.technicianId,
      set: { attendanceId, latitude, longitude, address: address ?? null, updatedAt: now },
    });

  // Also append to history (locationPings)
  await db.insert(locationPings).values({
    id: randomUUID(),
    attendanceId,
    technicianId,
    latitude,
    longitude,
    address: address ?? null,
    recordedAt: now,
  });

  res.json({ ok: true });
});

// GET /technician-locations — admin: latest live location for all technicians with a recent ping
router.get("/technician-locations", requireAdmin, async (req, res) => {
  const now = new Date();
  // Show any technician who has pinged in the last 4 hours
  const cutoff = new Date(now.getTime() - 4 * 60 * 60 * 1000);

  const latestLocs = await db
    .select()
    .from(technicianLocations)
    .where(gte(technicianLocations.updatedAt, cutoff));

  if (latestLocs.length === 0) {
    res.json([]);
    return;
  }

  const techIds = latestLocs.map(l => l.technicianId);
  const techUsers = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, techIds));
  const nameById = new Map(techUsers.map(u => [u.id, u.name]));

  // Also check for active attendance (checked in today) to show status
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const activeRows = await db
    .select({ id: attendance.id, technicianId: attendance.technicianId, checkInAt: attendance.checkInAt })
    .from(attendance)
    .where(and(gte(attendance.checkInAt, todayStart), isNull(attendance.checkOutAt)));
  const attByTech = new Map(activeRows.map(r => [r.technicianId, r]));

  const result = latestLocs.map(loc => {
    const att = attByTech.get(loc.technicianId);
    return {
      technicianId: loc.technicianId,
      name: nameById.get(loc.technicianId) ?? "Unknown",
      latitude: loc.latitude,
      longitude: loc.longitude,
      address: loc.address,
      recordedAt: loc.updatedAt.toISOString(),
      attendanceId: loc.attendanceId ?? null,
      checkInAt: att?.checkInAt.toISOString() ?? null,
      status: att ? "checked-in" : "online",
    };
  });

  res.json(result);
});

// GET /attendance/:id/location-trail — admin gets ordered ping list for a session
router.get("/attendance/:id/location-trail", requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  const pings = await db.select()
    .from(locationPings)
    .where(eq(locationPings.attendanceId, id))
    .orderBy(locationPings.recordedAt);

  res.json(pings.map(p => ({
    id: p.id,
    attendanceId: p.attendanceId,
    technicianId: p.technicianId,
    latitude: p.latitude,
    longitude: p.longitude,
    address: p.address,
    recordedAt: p.recordedAt.toISOString(),
  })));
});

export default router;
