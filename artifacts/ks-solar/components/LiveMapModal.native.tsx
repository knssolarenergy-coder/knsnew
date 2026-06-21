import { Feather } from "@expo/vector-icons";
import { useGetTechnicianLiveLocations } from "@workspace/api-client-react";
import MapboxGL, { Camera as MapboxCamera } from "@rnmapbox/maps";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  if (diff < 60) return `${diff} min ago`;
  const h = Math.floor(diff / 60);
  return `${h}h ${diff % 60}m ago`;
}

interface LocEntry {
  technicianId: string;
  name: string;
  latitude: string;
  longitude: string;
  status: string;
  checkInAt?: string | null;
  recordedAt: string;
  address?: string | null;
}

const TechPin = React.memo(function TechPin({
  name, color, selected,
}: { name: string; color: string; selected: boolean }) {
  return (
    <View style={pin.root} pointerEvents="none">
      <View style={[
        pin.dot,
        {
          backgroundColor: color,
          transform: [{ scale: selected ? 1.3 : 1 }],
          borderWidth: selected ? 3 : 0,
          borderColor: "white",
        },
      ]} />
      <View style={[pin.pill, { backgroundColor: selected ? color : "white", borderColor: color }]}>
        <Text style={[pin.pillText, { color: selected ? "white" : color }]} numberOfLines={1}>
          {name}
        </Text>
      </View>
    </View>
  );
});

const pin = StyleSheet.create({
  root: { alignItems: "center", gap: 2 },
  dot: {
    width: 32, height: 32, borderRadius: 16,
    shadowColor: "#000", shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35, shadowRadius: 4, elevation: 6,
  },
  pill: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12,
    borderWidth: 1.5,
    shadowColor: "#000", shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15, shadowRadius: 3, elevation: 3,
  },
  pillText: { fontSize: 11, fontFamily: "Inter_700Bold", maxWidth: 100 },
});

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function LiveMapModal({ visible, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<React.ElementRef<typeof MapboxCamera>>(null);
  const hasFittedRef = useRef(false);
  const [selectedTechId, setSelectedTechId] = useState<string | null>(null);

  const { data: locations, refetch, isRefetching, isLoading } =
    useGetTechnicianLiveLocations({
      query: { queryKey: ["technician-live-locations-modal"], enabled: visible },
    });

  useEffect(() => {
    if (!visible) {
      hasFittedRef.current = false;
      setSelectedTechId(null);
      return;
    }
    hasFittedRef.current = false;
    refetch();
    const id = setInterval(() => { refetch(); }, 15_000);
    return () => clearInterval(id);
  }, [visible]);

  const locs: LocEntry[] = useMemo(
    () => (locations ?? []).filter(l => {
      const lat = parseFloat(l.latitude);
      const lng = parseFloat(l.longitude);
      return !isNaN(lat) && !isNaN(lng);
    }),
    [locations],
  );

  // Fit camera once when first locations arrive
  useEffect(() => {
    if (hasFittedRef.current || locs.length === 0) return;
    hasFittedRef.current = true;
    setTimeout(() => {
      if (locs.length === 1) {
        cameraRef.current?.setCamera({
          centerCoordinate: [parseFloat(locs[0].longitude), parseFloat(locs[0].latitude)],
          zoomLevel: 14,
          animationDuration: 800,
        });
      } else {
        const lngs = locs.map(l => parseFloat(l.longitude));
        const lats = locs.map(l => parseFloat(l.latitude));
        cameraRef.current?.fitBounds(
          [Math.max(...lngs), Math.max(...lats)],
          [Math.min(...lngs), Math.min(...lats)],
          [60, 60, 60, 60],
          800,
        );
      }
    }, 500);
  }, [locs]);

  // Fly to selected tech
  useEffect(() => {
    if (!selectedTechId) return;
    const loc = locs.find(l => l.technicianId === selectedTechId);
    if (!loc) return;
    cameraRef.current?.setCamera({
      centerCoordinate: [parseFloat(loc.longitude), parseFloat(loc.latitude)],
      zoomLevel: 15,
      animationDuration: 700,
      animationMode: "flyTo",
    });
  }, [selectedTechId]);

  const handlePinSelect = useCallback((techId: string) => {
    setSelectedTechId(id => id === techId ? null : techId);
  }, []);

  const hasToken = !!process.env.EXPO_PUBLIC_MAPBOX_TOKEN;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[s.root, { backgroundColor: colors.background, paddingTop: insets.top + 8 }]}>

        {/* Header */}
        <View style={[s.header, { borderBottomColor: colors.border, backgroundColor: colors.card }]}>
          <View style={[s.headerIcon, { backgroundColor: "#0891B218" }]}>
            <Feather name="map-pin" size={18} color="#0891B2" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.headerTitle, { color: colors.foreground }]}>Live Technician Map</Text>
            <Text style={[s.headerSub, { color: colors.mutedForeground }]}>
              {locs.length === 0 ? "No technicians checked in" : `${locs.length} active · refreshes every 15s`}
            </Text>
          </View>
          {isRefetching && <ActivityIndicator size="small" color="#0891B2" style={{ marginRight: 8 }} />}
          <TouchableOpacity onPress={onClose} style={s.closeBtn} activeOpacity={0.7}>
            <Feather name="x" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {/* Map */}
        <View style={s.mapWrapper}>
          {!hasToken ? (
            <View style={[s.noToken, { backgroundColor: colors.muted }]}>
              <Feather name="map" size={32} color={colors.mutedForeground} />
              <Text style={[s.noTokenText, { color: colors.mutedForeground }]}>
                EXPO_PUBLIC_MAPBOX_TOKEN not set
              </Text>
            </View>
          ) : isLoading ? (
            <View style={[s.mapLoading, { backgroundColor: "#F8FAFC" }]}>
              <ActivityIndicator size="large" color="#0891B2" />
              <Text style={[s.loadingText, { color: colors.mutedForeground }]}>Loading map…</Text>
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

              {locs.map((loc, idx) => {
                const color = TECH_COLORS[idx % TECH_COLORS.length];
                const isSelected = selectedTechId === loc.technicianId;
                return (
                  <MapboxGL.PointAnnotation
                    key={loc.technicianId}
                    id={`modal-tech-${loc.technicianId}`}
                    coordinate={[parseFloat(loc.longitude), parseFloat(loc.latitude)]}
                    onSelected={() => handlePinSelect(loc.technicianId)}
                  >
                    <TechPin name={loc.name} color={color} selected={isSelected} />
                  </MapboxGL.PointAnnotation>
                );
              })}
            </MapboxGL.MapView>
          )}

          {/* LIVE badge */}
          <View style={s.liveBadge} pointerEvents="none">
            <View style={[s.liveDot, { backgroundColor: isRefetching ? "#0891B2" : "#EF4444" }]} />
            <Text style={s.liveText}>{isRefetching ? "UPDATING" : "LIVE"}</Text>
          </View>
        </View>

        {/* Tech list */}
        <FlatList
          data={locs}
          keyExtractor={item => item.technicianId}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={s.listContent}
          ListEmptyComponent={
            !isLoading ? (
              <View style={[s.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Feather name="radio" size={32} color={colors.mutedForeground} />
                <Text style={[s.emptyTitle, { color: colors.foreground }]}>No Active Technicians</Text>
                <Text style={[s.emptySub, { color: colors.mutedForeground }]}>
                  Technicians appear here after check-in and first location ping.
                </Text>
                <TouchableOpacity
                  onPress={() => refetch()}
                  style={[s.refreshBtn, { backgroundColor: "#0891B218", borderColor: "#0891B244" }]}
                  activeOpacity={0.8}
                >
                  <Feather name="refresh-cw" size={13} color="#0891B2" />
                  <Text style={s.refreshBtnText}>Refresh</Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
          ListHeaderComponent={
            locs.length > 0 ? (
              <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>
                {locs.length} Technician{locs.length > 1 ? "s" : ""} Online
              </Text>
            ) : null
          }
          renderItem={({ item: loc, index: idx }) => {
            const pinColor = TECH_COLORS[idx % TECH_COLORS.length];
            const lat = parseFloat(loc.latitude);
            const lng = parseFloat(loc.longitude);
            const isSelected = selectedTechId === loc.technicianId;
            return (
              <TouchableOpacity
                style={[s.card, {
                  backgroundColor: colors.card,
                  borderColor: isSelected ? pinColor : colors.border,
                  borderWidth: isSelected ? 1.5 : 1,
                }]}
                onPress={() => handlePinSelect(loc.technicianId)}
                activeOpacity={0.8}
              >
                <View style={{ height: 3, backgroundColor: pinColor, borderTopLeftRadius: 14, borderTopRightRadius: 14 }} />
                <View style={s.cardBody}>
                  <View style={[s.avatar, { backgroundColor: pinColor + "22" }]}>
                    <Text style={[s.avatarText, { color: pinColor }]}>
                      {loc.name.trim().charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={[s.techName, { color: colors.foreground }]}>{loc.name}</Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      <View style={[s.chip, { backgroundColor: colors.muted }]}>
                        <Feather name="log-in" size={10} color={colors.mutedForeground} />
                        {loc.checkInAt ? <Text style={[s.chipText, { color: colors.mutedForeground }]}>In {formatTime(loc.checkInAt)}</Text> : null}
                      </View>
                      <View style={[s.chip, { backgroundColor: "#10B98115" }]}>
                        <Feather name="radio" size={10} color="#10B981" />
                        <Text style={[s.chipText, { color: "#10B981" }]}>{minutesAgo(loc.recordedAt)}</Text>
                      </View>
                      {!isNaN(lat) && !isNaN(lng) && (
                        <View style={[s.chip, { backgroundColor: colors.muted }]}>
                          <Feather name="crosshair" size={10} color={colors.mutedForeground} />
                          <Text style={[s.chipText, { color: colors.mutedForeground }]}>{lat.toFixed(4)}, {lng.toFixed(4)}</Text>
                        </View>
                      )}
                    </View>
                    {loc.address ? (
                      <Text style={[s.address, { color: colors.mutedForeground }]} numberOfLines={2}>
                        📍 {loc.address}
                      </Text>
                    ) : null}
                  </View>
                  <View style={[s.activeBadge, { backgroundColor: "#10B98115", borderColor: "#10B98144" }]}>
                    <View style={s.activeDot} />
                    <Text style={s.activeBadgeText}>
                      {loc.status.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
        />

      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1,
  },
  headerIcon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular" },
  closeBtn: { padding: 6 },
  mapWrapper: {
    marginHorizontal: 14, marginTop: 14,
    borderRadius: 16, overflow: "hidden",
    height: 300,
    backgroundColor: "#F1F5F9",
  },
  mapLoading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  loadingText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  noToken: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  noTokenText: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },
  liveBadge: {
    position: "absolute", top: 10, right: 10,
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "rgba(0,0,0,0.65)", borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { color: "white", fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  sectionLabel: {
    fontSize: 12, fontFamily: "Inter_600SemiBold",
    paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6,
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  listContent: { paddingBottom: 28 },
  emptyCard: {
    margin: 14, marginTop: 14, borderRadius: 16, borderWidth: 1,
    alignItems: "center", padding: 32, gap: 10,
  },
  emptyTitle: { fontSize: 17, fontFamily: "Inter_700Bold", textAlign: "center" },
  emptySub: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  refreshBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1, marginTop: 4,
  },
  refreshBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#0891B2" },
  card: {
    marginHorizontal: 14, marginBottom: 10,
    borderRadius: 14,
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 6, elevation: 2, overflow: "hidden",
  },
  cardBody: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 14 },
  avatar: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 18, fontFamily: "Inter_700Bold" },
  techName: { fontSize: 15, fontFamily: "Inter_700Bold" },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20,
  },
  chipText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  address: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  activeBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20,
    borderWidth: 1, alignSelf: "flex-start",
  },
  activeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#10B981" },
  activeBadgeText: { fontSize: 10, fontFamily: "Inter_700Bold", color: "#10B981" },
});
