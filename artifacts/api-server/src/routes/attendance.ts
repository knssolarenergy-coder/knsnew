import { Router } from "express";
import { db } from "@workspace/db";
import { attendance, locationPings, settings, sites, technicianLocations, users } from "@workspace/db/schema";
import { eq, desc, and, gte, lt, inArray, isNull } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth.js";
import { requireTechnician } from "../middleware/auth.js";
import { randomUUID } from "crypto";

const router = Router();

interface AttendanceSettings {
  deadlineHHMM: string;
  shiftEndHHMM: string;
}

async function getAttendanceSettings(): Promise<AttendanceSettings> {
  const rows = await db.select().from(settings)
    .where(inArray(settings.key, ["attendance_checkin_deadline", "attendance_shift_end"]));
  const get = (key: string, def: string) => rows.find(r => r.key === key)?.value ?? def;
  return {
    deadlineHHMM: get("attendance_checkin_deadline", "08:00"),
    shiftEndHHMM: get("attendance_shift_end", "18:00"),
  };
}

// Server runs in UTC; Pakistan is UTC+5
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
function toPKTMins(d: Date): number {
  const pkt = new Date(d.getTime() + PKT_OFFSET_MS);
  return pkt.getUTCHours() * 60 + pkt.getUTCMinutes();
}

function calcStats(
  checkIn: Date,
  checkOut: Date | null,
  deadlineHHMM: string,
  shiftEndHHMM: string
) {
  const [dlH = 8, dlM = 0] = deadlineHHMM.split(":").map(Number);
  const deadlineMins = dlH * 60 + dlM;
  const checkInMins = toPKTMins(checkIn);
  const isLate = checkInMins > deadlineMins;

  let totalHours: number | null = null;
  let overtimeHours: number | null = null;
  if (checkOut) {
    totalHours = (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60);
    const [seH = 18, seM = 0] = shiftEndHHMM.split(":").map(Number);
    const shiftEndMins = seH * 60 + seM;
    const checkOutMins = toPKTMins(checkOut);
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
    attSettings.shiftEndHHMM
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
  // Only return absent list after the configured alert time
  const [alertRow] = await db.select().from(settings).where(eq(settings.key, "attendance_absent_alert_time"));
  const alertTime = alertRow?.value ?? "09:00";
  const now = new Date();
  const currentHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (currentHHMM < alertTime) {
    res.json([]);
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

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
    .where(and(gte(attendance.checkInAt, today), lt(attendance.checkInAt, tomorrow)));

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

// GET /technician-locations — admin: latest live location per currently checked-in technician
router.get("/technician-locations", requireAdmin, async (req, res) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Active attendance records for today (checked in, not yet checked out)
  const activeRows = await db
    .select({
      id: attendance.id,
      technicianId: attendance.technicianId,
      checkInAt: attendance.checkInAt,
    })
    .from(attendance)
    .where(
      and(
        gte(attendance.checkInAt, todayStart),
        isNull(attendance.checkOutAt),
      )
    );

  if (activeRows.length === 0) {
    res.json([]);
    return;
  }

  const activeTechIds = activeRows.map(r => r.technicianId);
  const activeAttIds = activeRows.map(r => r.id);

  // Latest location from upsert table — must match the CURRENT active attendance session
  // (prevents showing stale locations from a previous check-in)
  const latestLocs = await db
    .select()
    .from(technicianLocations)
    .where(
      and(
        inArray(technicianLocations.technicianId, activeTechIds),
        inArray(technicianLocations.attendanceId, activeAttIds),
      )
    );

  if (latestLocs.length === 0) {
    res.json([]);
    return;
  }

  // Fetch technician names
  const techIds = latestLocs.map(l => l.technicianId);
  const techUsers = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, techIds));
  const nameById = new Map(techUsers.map(u => [u.id, u.name]));
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
      attendanceId: loc.attendanceId,
      checkInAt: att?.checkInAt.toISOString() ?? new Date().toISOString(),
      status: "checked-in",
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
