import { Feather } from "@expo/vector-icons";
import { useGetTechnicianLocationTrail, useGetTechnicianLiveLocations } from "@workspace/api-client-react";
import MapboxGL, { Camera as MapboxCamera } from "@rnmapbox/maps";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";

MapboxGL.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? "");

const PAKISTAN_CENTER: [number, number] = [69.3451, 30.3753];

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("en-PK", {
      hour: "2-digit", minute: "2-digit", hour12: true,
    });
  } catch { return iso; }
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-PK", {
      weekday: "short", month: "short", day: "numeric",
    });
  } catch { return iso; }
}

function minutesAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diff < 1) return "just now";
  if (diff === 1) return "1 min ago";
  if (diff < 60) return `${diff} min ago`;
  const h = Math.floor(diff / 60);
  return `${h}h ${diff % 60}m ago`;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  techId: string;
  techName: string;
}

export function TechTrailModal({ visible, onClose, techId, techName }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<React.ElementRef<typeof MapboxCamera>>(null);
  const hasFittedRef = useRef(false);

  const [date, setDate] = useState(todayString);
  const isToday = date === todayString();

  const {
    data: trail,
    refetch: refetchTrail,
    isLoading: loadingTrail,
    isRefetching: refetchingTrail,
  } = useGetTechnicianLocationTrail(
    { userId: techId, date },
    { query: { queryKey: ["tech-trail", techId, date], enabled: visible && !!techId } }
  );

  const {
    data: allLiveLocations,
    refetch: refetchLive,
  } = useGetTechnicianLiveLocations({
    query: { queryKey: ["tech-live", techId], enabled: visible && isToday },
  });

  const liveLocation = useMemo(() => {
    if (!isToday || !allLiveLocations) return null;
    return allLiveLocations.find((l) => l.technicianId === techId) ?? null;
  }, [allLiveLocations, techId, isToday]);

  const trailPoints = useMemo(() => {
    if (!trail) return [];
    return trail.filter((p) => {
      const lat = parseFloat(p.latitude);
      const lng = parseFloat(p.longitude);
      return !isNaN(lat) && !isNaN(lng);
    });
  }, [trail]);

  const trailGeoJSON = useMemo(() => {
    if (trailPoints.length < 2) return null;
    return {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: trailPoints.map((p) => [
          parseFloat(p.longitude),
          parseFloat(p.latitude),
        ]),
      },
      properties: {},
    };
  }, [trailPoints]);

  const firstPoint = trailPoints[0];
  const lastPoint = trailPoints[trailPoints.length - 1];
  const currentPoint = liveLocation ?? (isToday ? lastPoint ?? null : lastPoint ?? null);

  useEffect(() => {
    if (!visible) {
      hasFittedRef.current = false;
      return;
    }
    hasFittedRef.current = false;
    refetchTrail();
    if (isToday) refetchLive();
  }, [visible, date]);

  useEffect(() => {
    if (!visible || isToday) return;
    const id = setInterval(() => { refetchTrail(); refetchLive(); }, 30_000);
    return () => clearInterval(id);
  }, [visible, isToday]);

  useEffect(() => {
    if (hasFittedRef.current || trailPoints.length === 0) return;
    hasFittedRef.current = true;
    setTimeout(() => {
      if (trailPoints.length === 1) {
        cameraRef.current?.setCamera({
          centerCoordinate: [parseFloat(trailPoints[0].longitude), parseFloat(trailPoints[0].latitude)],
          zoomLevel: 14,
          animationDuration: 600,
        });
      } else {
        const lngs = trailPoints.map((p) => parseFloat(p.longitude));
        const lats = trailPoints.map((p) => parseFloat(p.latitude));
        cameraRef.current?.fitBounds(
          [Math.max(...lngs), Math.max(...lats)],
          [Math.min(...lngs), Math.min(...lats)],
          [70, 70, 70, 70],
          700,
        );
      }
    }, 500);
  }, [trailPoints]);

  const goDate = useCallback((offsetDays: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (s !== date) {
      setDate(s);
      hasFittedRef.current = false;
    }
  }, [date]);

  const hasToken = !!process.env.EXPO_PUBLIC_MAPBOX_TOKEN;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[s.root, { backgroundColor: colors.background }]}>

        {/* Header */}
        <View style={[s.header, {
          paddingTop: insets.top + 10,
          backgroundColor: "#0891B2",
        }]}>
          <TouchableOpacity onPress={onClose} style={s.closeBtn} activeOpacity={0.7}>
            <Feather name="arrow-left" size={20} color="white" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle} numberOfLines={1}>{techName}</Text>
            <Text style={s.headerSub}>
              {trailPoints.length > 0
                ? `${trailPoints.length} pings · ${formatDate(firstPoint!.recordedAt)} ${formatTime(firstPoint!.recordedAt)} → ${formatTime(lastPoint!.recordedAt)}`
                : "No pings for this date"}
            </Text>
          </View>
          {(refetchingTrail) && (
            <ActivityIndicator size="small" color="white" style={{ marginRight: 8 }} />
          )}
        </View>

        {/* Date picker bar */}
        <View style={[s.datePicker, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.datePickerContent}>
            {[
              { label: "Today", offset: 0 },
              { label: "Yesterday", offset: -1 },
              { label: "-2d", offset: -2 },
              { label: "-3d", offset: -3 },
              { label: "-7d", offset: -7 },
            ].map((btn) => {
              const d = new Date();
              d.setDate(d.getDate() + btn.offset);
              const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              const active = ds === date;
              return (
                <TouchableOpacity
                  key={btn.label}
                  style={[s.dateBtn, {
                    backgroundColor: active ? "#0891B2" : colors.muted,
                    borderColor: active ? "#0891B2" : colors.border,
                  }]}
                  onPress={() => { goDate(btn.offset); }}
                  activeOpacity={0.7}
                >
                  <Text style={[s.dateBtnText, { color: active ? "white" : colors.mutedForeground }]}>
                    {btn.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <View style={s.dateSep} />
            <Text style={[s.dateDisplay, { color: colors.foreground }]}>{date}</Text>
          </ScrollView>
        </View>

        {/* Map */}
        <View style={s.mapWrapper}>
          {!hasToken ? (
            <View style={[s.center, { backgroundColor: colors.muted }]}>
              <Feather name="map" size={32} color={colors.mutedForeground} />
              <Text style={[s.centerText, { color: colors.mutedForeground }]}>Mapbox token not configured</Text>
            </View>
          ) : loadingTrail ? (
            <View style={[s.center, { backgroundColor: "#F8FAFC" }]}>
              <ActivityIndicator size="large" color="#0891B2" />
              <Text style={[s.centerText, { color: colors.mutedForeground }]}>Loading trail…</Text>
            </View>
          ) : (
            <MapboxGL.MapView
              style={StyleSheet.absoluteFill}
              styleURL="mapbox://styles/mapbox/light-v11"
              logoEnabled={false}
              attributionEnabled={false}
              compassEnabled={false}
              scaleBarEnabled={false}
            >
              <MapboxGL.Camera
                ref={cameraRef}
                zoomLevel={5}
                centerCoordinate={PAKISTAN_CENTER}
              />

              {/* Trail polyline */}
              {trailGeoJSON && (
                <MapboxGL.ShapeSource id="trail-source" shape={trailGeoJSON}>
                  <MapboxGL.LineLayer
                    id="trail-line"
                    style={{
                      lineColor: "#0891B2",
                      lineWidth: 3,
                      lineOpacity: 0.75,
                      lineCap: "round",
                      lineJoin: "round",
                    }}
                  />
                </MapboxGL.ShapeSource>
              )}

              {/* Start marker (green) */}
              {firstPoint && trailPoints.length > 1 && (
                <MapboxGL.PointAnnotation
                  key="trail-start"
                  id="trail-start"
                  coordinate={[parseFloat(firstPoint.longitude), parseFloat(firstPoint.latitude)]}
                >
                  <View style={[s.dotWrap]}>
                    <View style={[s.dot, { backgroundColor: "#10B981" }]} />
                    <Text style={s.dotLabel}>Start {formatTime(firstPoint.recordedAt)}</Text>
                  </View>
                </MapboxGL.PointAnnotation>
              )}

              {/* Live / latest dot */}
              {currentPoint && (
                <MapboxGL.PointAnnotation
                  key="tech-current"
                  id="tech-current"
                  coordinate={[
                    parseFloat(
                      (currentPoint as { longitude: string }).longitude
                    ),
                    parseFloat(
                      (currentPoint as { latitude: string }).latitude
                    ),
                  ]}
                >
                  <View style={s.dotWrap}>
                    <View style={[s.dot, s.dotLive, { backgroundColor: isToday && liveLocation ? "#EF4444" : "#F59E0B" }]} />
                    <Text style={s.dotLabel}>
                      {isToday && liveLocation
                        ? `Now · ${minutesAgo(liveLocation.recordedAt)}`
                        : lastPoint ? `Last · ${formatTime(lastPoint.recordedAt)}` : ""}
                    </Text>
                  </View>
                </MapboxGL.PointAnnotation>
              )}
            </MapboxGL.MapView>
          )}

          {/* Trail count badge */}
          {trailPoints.length > 0 && (
            <View style={s.trailBadge} pointerEvents="none">
              <Feather name="navigation" size={10} color="white" />
              <Text style={s.trailBadgeText}>{trailPoints.length} pings</Text>
            </View>
          )}

          {/* Live badge */}
          {isToday && (
            <View style={[s.liveBadge, { right: trailPoints.length > 0 ? 90 : 10 }]} pointerEvents="none">
              <View style={[s.liveDot, { backgroundColor: liveLocation ? "#EF4444" : "#6B7280" }]} />
              <Text style={s.liveText}>{liveLocation ? "LIVE" : "OFFLINE"}</Text>
            </View>
          )}
        </View>

        {/* Stats row */}
        <View style={[s.stats, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
          <View style={s.stat}>
            <Text style={[s.statNum, { color: colors.foreground }]}>{trailPoints.length}</Text>
            <Text style={[s.statLabel, { color: colors.mutedForeground }]}>Pings</Text>
          </View>
          {firstPoint ? (
            <View style={s.stat}>
              <Text style={[s.statNum, { color: colors.foreground }]}>{formatTime(firstPoint.recordedAt)}</Text>
              <Text style={[s.statLabel, { color: colors.mutedForeground }]}>First Seen</Text>
            </View>
          ) : null}
          {lastPoint ? (
            <View style={s.stat}>
              <Text style={[s.statNum, { color: colors.foreground }]}>{formatTime(lastPoint.recordedAt)}</Text>
              <Text style={[s.statLabel, { color: colors.mutedForeground }]}>Last Seen</Text>
            </View>
          ) : null}
          {isToday && liveLocation ? (
            <View style={s.stat}>
              <Text style={[s.statNum, { color: "#10B981" }]}>{minutesAgo(liveLocation.recordedAt)}</Text>
              <Text style={[s.statLabel, { color: colors.mutedForeground }]}>Updated</Text>
            </View>
          ) : null}
        </View>

        {/* Empty state */}
        {!loadingTrail && trailPoints.length === 0 && (
          <View style={[s.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="map-pin" size={36} color={colors.mutedForeground} />
            <Text style={[s.emptyTitle, { color: colors.foreground }]}>No Location Data</Text>
            <Text style={[s.emptySub, { color: colors.mutedForeground }]}>
              {techName} had no GPS pings on {date}.{"\n"}
              Location is tracked automatically when the app is running.
            </Text>
            <TouchableOpacity
              style={[s.refreshBtn, { backgroundColor: "#0891B218", borderColor: "#0891B244" }]}
              onPress={() => refetchTrail()}
              activeOpacity={0.8}
            >
              <Feather name="refresh-cw" size={13} color="#0891B2" />
              <Text style={s.refreshBtnText}>Refresh</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingBottom: 14,
  },
  closeBtn: { padding: 6 },
  headerTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: "white" },
  headerSub: { fontSize: 11, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.8)", marginTop: 2 },
  datePicker: { borderBottomWidth: 1 },
  datePickerContent: { paddingHorizontal: 12, paddingVertical: 8, gap: 6, alignItems: "center", flexDirection: "row" },
  dateBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1,
  },
  dateBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  dateSep: { width: 1, height: 20, backgroundColor: "#E2E8F0" },
  dateDisplay: { fontSize: 12, fontFamily: "Inter_500Medium" },
  mapWrapper: {
    flex: 1,
    backgroundColor: "#F1F5F9",
    position: "relative",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  centerText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  dotWrap: { alignItems: "center", gap: 2 },
  dot: {
    width: 14, height: 14, borderRadius: 7,
    borderWidth: 2, borderColor: "white",
    shadowColor: "#000", shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35, shadowRadius: 3, elevation: 5,
  },
  dotLive: {
    width: 18, height: 18, borderRadius: 9,
    shadowOpacity: 0.4, shadowRadius: 4,
  },
  dotLabel: {
    fontSize: 9, fontFamily: "Inter_600SemiBold",
    color: "#1E293B",
    backgroundColor: "rgba(255,255,255,0.9)",
    paddingHorizontal: 5, paddingVertical: 2,
    borderRadius: 6,
  },
  trailBadge: {
    position: "absolute", top: 10, right: 10,
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(8,145,178,0.85)", borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  trailBadgeText: { color: "white", fontSize: 11, fontFamily: "Inter_700Bold" },
  liveBadge: {
    position: "absolute", top: 10,
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "rgba(0,0,0,0.65)", borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { color: "white", fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  stats: {
    flexDirection: "row", borderTopWidth: 1,
    paddingVertical: 12, paddingHorizontal: 16,
  },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statNum: { fontSize: 15, fontFamily: "Inter_700Bold" },
  statLabel: { fontSize: 10, fontFamily: "Inter_400Regular" },
  emptyCard: {
    margin: 16, borderRadius: 16, borderWidth: 1,
    alignItems: "center", padding: 32, gap: 10,
  },
  emptyTitle: { fontSize: 17, fontFamily: "Inter_700Bold", textAlign: "center" },
  emptySub: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  refreshBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1, marginTop: 4,
  },
  refreshBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#0891B2" },
});
