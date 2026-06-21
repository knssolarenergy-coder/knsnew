import { Feather } from "@expo/vector-icons";
import {
  useGetAttendance,
  useGetLocationTrail,
  useGetTechnicianLiveLocations,
} from "@workspace/api-client-react";
import MapboxGL, { Camera as MapboxCamera } from "@rnmapbox/maps";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";

MapboxGL.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? "");

const TECH_COLORS = [
  "#3B82F6", "#10B981", "#8B5CF6", "#F59E0B",
  "#EF4444", "#06B6D4", "#EC4899", "#84CC16",
];

const PAKISTAN_CENTER: [number, number] = [69.3451, 30.3753];

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("en-PK", {
      hour: "2-digit", minute: "2-digit", hour12: true,
    });
  } catch { return iso; }
}

function minutesAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diff < 1) return "just now";
  if (diff === 1) return "1 min ago";
  if (diff < 60) return `${diff}m ago`;
  return `${Math.floor(diff / 60)}h ${diff % 60}m ago`;
}

function statusColor(status: string): string {
  if (status === "active") return "#10B981";
  if (status === "away") return "#F59E0B";
  return "#94A3B8";
}

// Stable pin component — memoised to prevent Mapbox PointAnnotation flicker
const TechPin = React.memo(function TechPin({
  name, color, selected,
}: { name: string; color: string; selected: boolean }) {
  return (
    <View style={s.pinRoot} pointerEvents="none">
      <View style={[s.pinDot, { backgroundColor: color, transform: [{ scale: selected ? 1.25 : 1 }], borderWidth: selected ? 3 : 0, borderColor: "white" }]} />
      <View style={[s.namePill, { backgroundColor: selected ? color : "white", borderColor: color }]}>
        <Text style={[s.namePillText, { color: selected ? "white" : color }]} numberOfLines={1}>
          {name}
        </Text>
      </View>
    </View>
  );
});

export function LiveMapSection() {
  const colors = useColors();
  const cameraRef = useRef<React.ElementRef<typeof MapboxCamera>>(null);
  const hasFittedRef = useRef(false);

  const [selectedTechId, setSelectedTechId] = useState<string | null>(null);
  const [selectedColor, setSelectedColor] = useState(TECH_COLORS[0]);
  const [showTrail, setShowTrail] = useState(false);
  const [isSatellite, setIsSatellite] = useState(false);
  const mapStyleURL = isSatellite
    ? "mapbox://styles/mapbox/satellite-streets-v12"
    : "mapbox://styles/mapbox/light-v11";

  const today = useMemo(() => new Date().toISOString().split("T")[0], []);

  const { data: locations, isRefetching, isLoading } =
    useGetTechnicianLiveLocations({
      query: { queryKey: ["tech-live-native"], refetchInterval: 5_000 },
    });

  const { data: todayAttendance } = useGetAttendance(
    { date: today, technicianId: selectedTechId ?? undefined },
    {
      query: {
        queryKey: ["attendance-today-native", today, selectedTechId],
        enabled: !!selectedTechId,
      },
    },
  );

  const selectedAttendanceId = useMemo(() => {
    if (!selectedTechId || !todayAttendance) return null;
    return todayAttendance.find((r) => !r.checkOutAt)?.id ?? null;
  }, [selectedTechId, todayAttendance]);

  const { data: trail, isLoading: trailLoading } = useGetLocationTrail(
    selectedAttendanceId ?? "",
    {
      query: {
        queryKey: ["trail-native", selectedAttendanceId],
        enabled: !!selectedAttendanceId && showTrail,
        refetchInterval: showTrail ? 5_000 : false,
      },
    },
  );

  // All technicians returned by API (including those with no location yet)
  const allLocs = useMemo(() => locations ?? [], [locations]);

  // Only those with valid coordinates — used for map pins
  const locs = useMemo(
    () =>
      allLocs.filter(
        (l) => !isNaN(parseFloat(l.latitude)) && !isNaN(parseFloat(l.longitude)),
      ),
    [allLocs],
  );

  const activeLocs = useMemo(
    () => allLocs.filter((l) => l.status === "active"),
    [allLocs],
  );

  // GeoJSON [lng, lat] for Mapbox (note: opposite of react-native-maps)
  const trailLine = useMemo(() => {
    if (!trail || trail.length < 2) return null;
    const coords = trail
      .filter(
        (p) => !isNaN(parseFloat(p.latitude)) && !isNaN(parseFloat(p.longitude)),
      )
      .map((p) => [parseFloat(p.longitude), parseFloat(p.latitude)] as [number, number]);
    if (coords.length < 2) return null;
    return {
      type: "Feature" as const,
      geometry: { type: "LineString" as const, coordinates: coords },
      properties: {},
    };
  }, [trail]);

  // GeoJSON FeatureCollection — one Point per ping for CircleLayer dots
  const trailPoints = useMemo(() => {
    if (!trail || trail.length === 0) return null;
    const features = trail
      .filter((p) => !isNaN(parseFloat(p.latitude)) && !isNaN(parseFloat(p.longitude)))
      .map((p) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [parseFloat(p.longitude), parseFloat(p.latitude)] as [number, number],
        },
        properties: {},
      }));
    if (features.length === 0) return null;
    return { type: "FeatureCollection" as const, features };
  }, [trail]);

  // ─── Camera: initial fit (only once) ─────────────────────────────────────
  useEffect(() => {
    if (hasFittedRef.current || locs.length === 0) return;
    hasFittedRef.current = true;
    setTimeout(() => {
      if (locs.length === 1) {
        cameraRef.current?.flyTo(
          [parseFloat(locs[0].longitude), parseFloat(locs[0].latitude)],
          800,
        );
        cameraRef.current?.zoomTo(14, 800);
      } else {
        const lngs = locs.map((l) => parseFloat(l.longitude));
        const lats = locs.map((l) => parseFloat(l.latitude));
        cameraRef.current?.fitBounds(
          [Math.max(...lngs), Math.max(...lats)],
          [Math.min(...lngs), Math.min(...lats)],
          [80, 60, 200, 60],
          800,
        );
      }
    }, 600);
  }, [locs]);

  // ─── Camera: fly to selected tech ────────────────────────────────────────
  useEffect(() => {
    if (!selectedTechId) return;
    const loc = locs.find((l) => l.technicianId === selectedTechId);
    if (!loc) return;
    cameraRef.current?.setCamera({
      centerCoordinate: [parseFloat(loc.longitude), parseFloat(loc.latitude)],
      zoomLevel: 15,
      animationDuration: 700,
      animationMode: "flyTo",
    });
  }, [selectedTechId]);

  // ─── Camera: fit to trail ─────────────────────────────────────────────────
  useEffect(() => {
    if (!trailLine) return;
    const coords = trailLine.geometry.coordinates;
    setTimeout(() => {
      if (coords.length === 1) {
        cameraRef.current?.flyTo(coords[0], 600);
      } else {
        const lngs = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        cameraRef.current?.fitBounds(
          [Math.max(...lngs), Math.max(...lats)],
          [Math.min(...lngs), Math.min(...lats)],
          [80, 60, 240, 60],
          600,
        );
      }
    }, 350);
  }, [trailLine]);

  const handleTechSelect = useCallback(
    (techId: string, color: string) => {
      if (selectedTechId === techId) {
        setSelectedTechId(null);
        setShowTrail(false);
      } else {
        setSelectedTechId(techId);
        setSelectedColor(color);
        setShowTrail(true);
      }
    },
    [selectedTechId],
  );

  const selectedLoc = useMemo(
    () => locs.find((l) => l.technicianId === selectedTechId),
    [locs, selectedTechId],
  );

  const hasToken = !!process.env.EXPO_PUBLIC_MAPBOX_TOKEN;

  if (!hasToken) {
    return (
      <View style={[s.setupScreen, { backgroundColor: colors.background }]}>
        <Feather name="map" size={48} color={colors.mutedForeground} />
        <Text style={[s.setupTitle, { color: colors.foreground }]}>Mapbox Token Required</Text>
        <Text style={[s.setupSub, { color: colors.mutedForeground }]}>
          Add your Mapbox public token as{"\n"}
          <Text style={{ fontFamily: "Inter_700Bold" }}>EXPO_PUBLIC_MAPBOX_TOKEN</Text>
          {"\n"}in Replit Secrets to enable the live map.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <MapboxGL.MapView
        style={StyleSheet.absoluteFill}
        styleURL={mapStyleURL}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled
        compassPosition={{ top: 110, right: 12 }}
        scaleBarEnabled={false}
      >
        <MapboxGL.Camera
          ref={cameraRef}
          zoomLevel={5}
          centerCoordinate={PAKISTAN_CENTER}
        />

        {/* Trail polyline */}
        {trailLine && (
          <MapboxGL.ShapeSource id="trail-src" shape={trailLine}>
            <MapboxGL.LineLayer
              id="trail-line"
              style={{
                lineColor: "#3B82F6",
                lineWidth: 3,
                lineCap: "round",
                lineJoin: "round",
                lineOpacity: 0.9,
              }}
            />
          </MapboxGL.ShapeSource>
        )}

        {/* Trail ping dots — one circle per ping point */}
        {trailPoints && (
          <MapboxGL.ShapeSource id="trail-points-src" shape={trailPoints}>
            <MapboxGL.CircleLayer
              id="trail-circles"
              style={{
                circleRadius: 4,
                circleColor: "#3B82F6",
                circleOpacity: 0.85,
                circleStrokeWidth: 1.5,
                circleStrokeColor: "#ffffff",
              }}
            />
          </MapboxGL.ShapeSource>
        )}

        {/* Technician pins */}
        {locs.map((loc, idx) => {
          const color = TECH_COLORS[idx % TECH_COLORS.length];
          const isSelected = selectedTechId === loc.technicianId;
          return (
            <MapboxGL.PointAnnotation
              key={loc.technicianId}
              id={`tech-${loc.technicianId}`}
              coordinate={[parseFloat(loc.longitude), parseFloat(loc.latitude)]}
              onSelected={() => handleTechSelect(loc.technicianId, color)}
            >
              <TechPin name={loc.name} color={color} selected={isSelected} />
            </MapboxGL.PointAnnotation>
          );
        })}
      </MapboxGL.MapView>

      {/* ── Loading overlay ── */}
      {isLoading && (
        <View style={s.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#0891B2" />
        </View>
      )}

      {/* ── Top overlays ── */}
      <View style={s.topOverlay} pointerEvents="none">
        {allLocs.length > 0 && (
          <View style={s.countBadge}>
            <View style={s.countDot} />
            <Text style={s.countText}>
              {activeLocs.length > 0 ? `${activeLocs.length} Active` : `${allLocs.length} Techs`}
            </Text>
          </View>
        )}
        <View style={[s.liveBadge, { backgroundColor: isRefetching ? "rgba(14,165,233,0.85)" : "rgba(0,0,0,0.70)" }]}>
          <View style={[s.liveDot, { backgroundColor: isRefetching ? "white" : "#EF4444" }]} />
          <Text style={s.liveText}>{isRefetching ? "UPDATING" : "LIVE"}</Text>
        </View>
      </View>

      {/* ── Empty state ── */}
      {!isLoading && allLocs.length === 0 && (
        <View style={s.emptyOverlay} pointerEvents="none">
          <View style={s.emptyCard}>
            <Feather name="radio" size={28} color="#64748B" />
            <Text style={s.emptyTitle}>No Technicians Found</Text>
            <Text style={s.emptySub}>No approved technicians in the system yet.</Text>
          </View>
        </View>
      )}

      {/* ── Satellite / Street toggle (rendered last so it stays on top of all overlays) ── */}
      <TouchableOpacity
        style={[s.styleToggle, { backgroundColor: isSatellite ? "rgba(15,23,42,0.82)" : "rgba(255,255,255,0.92)" }]}
        onPress={() => setIsSatellite((v) => !v)}
        activeOpacity={0.85}
      >
        <Feather name={isSatellite ? "map" : "layers"} size={14} color={isSatellite ? "#ffffff" : "#0F172A"} />
        <Text style={[s.styleToggleText, { color: isSatellite ? "#ffffff" : "#0F172A" }]}>
          {isSatellite ? "Street" : "Satellite"}
        </Text>
      </TouchableOpacity>

      {/* ── Bottom: tech card strip (all technicians, not just those with coords) ── */}
      {!selectedTechId && allLocs.length > 0 && (
        <View style={s.cardStripWrapper}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.cardStripContent}
          >
            {allLocs.map((loc, idx) => {
              const pinColor = TECH_COLORS[idx % TECH_COLORS.length];
              const sColor = statusColor(loc.status);
              const hasCoords = !isNaN(parseFloat(loc.latitude)) && !isNaN(parseFloat(loc.longitude));
              return (
                <TouchableOpacity
                  key={loc.technicianId}
                  style={[s.techCard, { borderColor: pinColor }]}
                  onPress={() => hasCoords ? handleTechSelect(loc.technicianId, pinColor) : undefined}
                  activeOpacity={hasCoords ? 0.85 : 1}
                >
                  <View style={[s.techCardAccent, { backgroundColor: pinColor }]} />
                  <View style={s.techCardBody}>
                    <View style={[s.techAvatar, { backgroundColor: pinColor + "22" }]}>
                      <Text style={[s.techAvatarText, { color: pinColor }]}>
                        {loc.name.trim().charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.techCardName} numberOfLines={1}>{loc.name}</Text>
                      <View style={s.techCardRow}>
                        <View style={[s.statusDot, { backgroundColor: sColor }]} />
                        <Text style={[s.techCardSub, { color: sColor }]}>
                          {loc.status === "active" ? "Active" : loc.status === "away" ? "Away" : "Offline"}
                        </Text>
                      </View>
                      {loc.recordedAt
                        ? <Text style={s.techCardIn}>{minutesAgo(loc.recordedAt)}</Text>
                        : <Text style={s.techCardIn}>No location yet</Text>}
                    </View>
                  </View>
                  {hasCoords && <Text style={[s.techCardTrailHint, { color: pinColor }]}>Tap for trail →</Text>}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* ── Bottom: trail panel when tech selected ── */}
      {selectedTechId && selectedLoc && (
        <View style={[s.trailPanel, { backgroundColor: colors.card }]}>
          {/* Header */}
          <View style={[s.trailPanelHeader, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={[s.trailPanelDot, { backgroundColor: selectedColor }]} />
                <Text style={[s.trailPanelName, { color: colors.foreground }]} numberOfLines={1}>
                  {selectedLoc.name}
                </Text>
              </View>
              <Text style={[s.trailPanelSub, { color: colors.mutedForeground }]}>
                {selectedLoc.checkInAt ? `In ${formatTime(selectedLoc.checkInAt)} · ` : ""}{selectedLoc.recordedAt ? minutesAgo(selectedLoc.recordedAt) : "No location yet"}
              </Text>
            </View>
            <TouchableOpacity
              style={[s.closeBtn, { backgroundColor: colors.muted }]}
              onPress={() => { setSelectedTechId(null); setShowTrail(false); }}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            >
              <Feather name="x" size={14} color={colors.foreground} />
            </TouchableOpacity>
          </View>

          {/* Trail list */}
          <ScrollView style={{ maxHeight: 160 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 12, gap: 8 }}>
            {trailLoading ? (
              <ActivityIndicator size="small" color={selectedColor} style={{ marginVertical: 12 }} />
            ) : !selectedAttendanceId ? (
              <Text style={[s.trailEmpty, { color: colors.mutedForeground }]}>No active session found</Text>
            ) : !trail || trail.length === 0 ? (
              <Text style={[s.trailEmpty, { color: colors.mutedForeground }]}>No location pings yet</Text>
            ) : (
              [...trail].reverse().map((ping, i) => {
                const isLatest = i === 0;
                const t = new Date(ping.recordedAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
                return (
                  <TouchableOpacity
                    key={ping.id}
                    style={s.pingRow}
                    onPress={() => Linking.openURL(`https://maps.google.com/?q=${ping.latitude},${ping.longitude}`)}
                    activeOpacity={0.7}
                  >
                    <View style={[s.pingBullet, { backgroundColor: isLatest ? "#10B981" : selectedColor + "88" }]} />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={[s.pingTime, { color: colors.foreground }]}>{t}</Text>
                        {isLatest && (
                          <View style={s.liveChip}>
                            <Text style={s.liveChipText}>LIVE</Text>
                          </View>
                        )}
                      </View>
                      <Text style={[s.pingAddr, { color: colors.mutedForeground }]} numberOfLines={1}>
                        {ping.address || `${ping.latitude}, ${ping.longitude}`}
                      </Text>
                    </View>
                    <Feather name="external-link" size={12} color={colors.mutedForeground} />
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  // Setup screen
  setupScreen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  setupTitle: { fontSize: 20, fontFamily: "Inter_700Bold", textAlign: "center" },
  setupSub: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 },
  // Loading
  loadingOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.6)" },
  // Style toggle (satellite / street)
  styleToggle: { position: "absolute", top: Platform.OS === "ios" ? 160 : 116, right: 12, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(255,255,255,0.92)", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 4 },
  styleToggleText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  // Top overlays
  topOverlay: { position: "absolute", top: Platform.OS === "ios" ? 56 : 12, left: 12, right: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  countBadge: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.70)", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  countDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#10B981" },
  countText: { color: "white", fontSize: 12, fontFamily: "Inter_600SemiBold" },
  liveBadge: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { color: "white", fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  // Empty state
  emptyOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  emptyCard: { backgroundColor: "rgba(255,255,255,0.92)", borderRadius: 20, padding: 28, alignItems: "center", gap: 8, maxWidth: 260 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#0F172A", textAlign: "center" },
  emptySub: { fontSize: 13, fontFamily: "Inter_400Regular", color: "#64748B", textAlign: "center" },
  // Tech pin
  pinRoot: { alignItems: "center", gap: 2 },
  pinDot: { width: 30, height: 30, borderRadius: 15, shadowColor: "#000", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.35, shadowRadius: 4, elevation: 6 },
  namePill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, borderWidth: 1.5, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 3, elevation: 3 },
  namePillText: { fontSize: 11, fontFamily: "Inter_700Bold", maxWidth: 100 },
  // Trail dots
  trailDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: "white" },
  // Card strip
  cardStripWrapper: { position: "absolute", bottom: 0, left: 0, right: 0, paddingBottom: Platform.OS === "ios" ? 28 : 12 },
  cardStripContent: { paddingHorizontal: 12, gap: 10 },
  techCard: { width: 160, backgroundColor: "white", borderRadius: 14, borderWidth: 1.5, overflow: "hidden", shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 5 },
  techCardAccent: { height: 3 },
  techCardBody: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10 },
  techAvatar: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  techAvatarText: { fontSize: 16, fontFamily: "Inter_700Bold" },
  techCardName: { fontSize: 13, fontFamily: "Inter_700Bold", color: "#0F172A" },
  techCardRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  techCardSub: { fontSize: 11, fontFamily: "Inter_500Medium", color: "#64748B" },
  techCardIn: { fontSize: 10, fontFamily: "Inter_400Regular", color: "#94A3B8", marginTop: 1 },
  techCardTrailHint: { fontSize: 10, fontFamily: "Inter_600SemiBold", textAlign: "right", paddingRight: 10, paddingBottom: 8 },
  // Trail panel
  trailPanel: { position: "absolute", bottom: 0, left: 0, right: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, shadowColor: "#000", shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.12, shadowRadius: 12, elevation: 10, paddingBottom: Platform.OS === "ios" ? 28 : 4 },
  trailPanelHeader: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderBottomWidth: 1 },
  trailPanelDot: { width: 12, height: 12, borderRadius: 6 },
  trailPanelName: { fontSize: 15, fontFamily: "Inter_700Bold" },
  trailPanelSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  closeBtn: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  // Trail pings
  trailEmpty: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", paddingVertical: 12 },
  pingRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  pingBullet: { width: 8, height: 8, borderRadius: 4 },
  pingTime: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  pingAddr: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 1 },
  liveChip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, backgroundColor: "#10B98122", borderWidth: 1, borderColor: "#10B98144" },
  liveChipText: { fontSize: 9, fontFamily: "Inter_700Bold", color: "#10B981" },
});
