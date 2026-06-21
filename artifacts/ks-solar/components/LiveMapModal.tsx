import { Feather } from "@expo/vector-icons";
import { useGetTechnicianLiveLocations } from "@workspace/api-client-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";

const TECH_COLORS = [
  "#3B82F6", "#10B981", "#8B5CF6", "#F59E0B",
  "#EF4444", "#06B6D4", "#EC4899", "#84CC16",
];

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

function statusColor(status: string): string {
  if (status === "active") return "#10B981";
  if (status === "away") return "#F59E0B";
  return "#94A3B8";
}

function statusLabel(status: string): string {
  if (status === "active") return "Active";
  if (status === "away") return "Away";
  return "Offline";
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

function buildMapHtml(token: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css" rel="stylesheet"/>
  <script src="https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js"></script>
  <style>
    * { box-sizing:border-box;margin:0;padding:0; }
    body { background:#F8FAFC; }
    #map { width:100vw;height:100vh; }
    .pin-wrap { display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer; }
    .pin-dot { width:34px;height:34px;border-radius:50%;border:3px solid white;box-shadow:0 3px 10px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:white;font-family:sans-serif; }
    .pin-lbl { font-size:11px;font-weight:700;font-family:sans-serif;padding:2px 8px;border-radius:10px;border-width:1.5px;border-style:solid;white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis; }
    .mapboxgl-popup-content { border-radius:12px!important;padding:12px 14px!important;box-shadow:0 8px 24px rgba(0,0,0,0.18)!important;min-width:170px; }
    .mapboxgl-popup-tip { display:none; }
    .p-name { font-weight:700;font-size:14px;margin-bottom:5px; }
    .p-badge { display:inline-block;font-size:10px;font-weight:700;border-radius:20px;padding:2px 8px;margin-bottom:7px;background:#10B98115;color:#059669;border:1px solid #10B98140; }
    .p-row { font-size:12px;color:#555;margin-bottom:2px; }
    .p-ping { font-size:12px;font-weight:600;color:#10B981;margin-top:4px; }
  </style>
</head>
<body>
<div id="map"></div>
<script>
(function() {
  mapboxgl.accessToken = '${token}';
  var map = new mapboxgl.Map({ container:'map', style:'mapbox://styles/mapbox/light-v11', center:[69.3451,30.3753], zoom:5, attributionControl:false });
  map.addControl(new mapboxgl.NavigationControl({ showCompass:false }), 'top-right');
  var markers = {}; var hasFitted = false;

  function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString('en-PK',{hour:'2-digit',minute:'2-digit',hour12:true}); } catch(e){ return iso; } }
  function minsAgo(iso) { var d=Math.floor((Date.now()-new Date(iso).getTime())/60000); if(d<1) return 'just now'; if(d===1) return '1 min ago'; if(d<60) return d+' min ago'; return Math.floor(d/60)+'h '+(d%60)+'m ago'; }
  function cap(s) { return s.replace(/-/g,' ').replace(/\\b\\w/g,function(c){return c.toUpperCase();}); }

  function makeEl(color, initial, name) {
    var w=document.createElement('div'); w.className='pin-wrap';
    var dot=document.createElement('div'); dot.className='pin-dot'; dot.style.background=color; dot.textContent=initial; w.appendChild(dot);
    var lbl=document.createElement('div'); lbl.className='pin-lbl'; lbl.style.background=color+'22'; lbl.style.borderColor=color; lbl.style.color=color; lbl.textContent=name.split(' ')[0]; w.appendChild(lbl);
    return w;
  }
  function popupHtml(d) {
    return '<div class="p-name" style="color:'+d.color+'">'+d.name+'</div>'
      +'<div class="p-badge">● '+cap(d.status)+'</div>'
      +'<div class="p-row">🕐 In: '+fmtTime(d.checkInAt)+'</div>'
      +'<div class="p-row">📍 '+d.lat.toFixed(5)+', '+d.lng.toFixed(5)+'</div>'
      +(d.address?'<div class="p-row">'+d.address+'</div>':'')
      +'<div class="p-ping">📡 '+minsAgo(d.recordedAt)+'</div>';
  }

  function setMarkers(data) {
    var seen={}; var coords=[];
    data.forEach(function(d) {
      if(isNaN(d.lat)||isNaN(d.lng)) return;
      seen[d.id]=true; coords.push([d.lng,d.lat]);
      if(markers[d.id]) { markers[d.id].m.setLngLat([d.lng,d.lat]); markers[d.id].p.setHTML(popupHtml(d)); }
      else { var el=makeEl(d.color,d.name.trim().charAt(0).toUpperCase(),d.name); var p=new mapboxgl.Popup({offset:20}).setHTML(popupHtml(d)); var m=new mapboxgl.Marker({element:el}).setLngLat([d.lng,d.lat]).setPopup(p).addTo(map); markers[d.id]={m,p}; }
    });
    Object.keys(markers).forEach(function(id){ if(!seen[id]){ markers[id].m.remove(); delete markers[id]; } });
    return coords;
  }

  function fitView(coords) {
    if(hasFitted||coords.length===0) return; hasFitted=true;
    if(coords.length===1) { map.flyTo({center:coords[0],zoom:14}); }
    else { var b=coords.reduce(function(b,c){return b.extend(c);},new mapboxgl.LngLatBounds(coords[0],coords[0])); map.fitBounds(b,{padding:60,maxZoom:14}); }
  }

  window.addEventListener('message', function(e) {
    if(!e.data||e.data.type!=='UPDATE_MARKERS') return;
    fitView(setMarkers(e.data.markers));
  });
})();
</script>
</body>
</html>`;
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function LiveMapModal({ visible, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mapReadyRef = useRef(false);
  // Bumped on every open to force a fresh map mount (resets the in-page
  // hasFitted flag and clears any markers left over from a previous session).
  const [mapKey, setMapKey] = useState(0);

  const { data: locations, refetch, isRefetching, isLoading } =
    useGetTechnicianLiveLocations({
      query: { queryKey: ["technician-live-locations"], enabled: visible },
    });

  useEffect(() => {
    if (!visible) {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      mapReadyRef.current = false;
      return;
    }
    mapReadyRef.current = false;
    setMapKey(k => k + 1);
    refetch();
    refreshIntervalRef.current = setInterval(() => { refetch(); }, 30 * 1000);
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, [visible]);

  // All technicians — used for card list
  const allLocs: LocEntry[] = (locations ?? []) as LocEntry[];

  // Only those with valid coords — used for iframe map markers
  const locs: LocEntry[] = allLocs.filter(l => {
    const lat = parseFloat(l.latitude);
    const lng = parseFloat(l.longitude);
    return !isNaN(lat) && !isNaN(lng);
  });

  // Keep the freshest locations in a ref so we can push them into the iframe
  // both on data change and right after the map finishes loading (covers the
  // race where data arrives before the iframe is ready).
  const locsRef = useRef<LocEntry[]>([]);
  locsRef.current = locs;

  function pushMarkers() {
    if (!mapReadyRef.current) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    const markers = locsRef.current.map((loc, idx) => ({
      id: loc.technicianId,
      lat: parseFloat(loc.latitude),
      lng: parseFloat(loc.longitude),
      name: loc.name,
      color: TECH_COLORS[idx % TECH_COLORS.length],
      status: loc.status,
      checkInAt: loc.checkInAt,
      recordedAt: loc.recordedAt,
      address: loc.address ?? "",
    }));
    iframe.contentWindow.postMessage({ type: "UPDATE_MARKERS", markers }, "*");
  }

  // Send live update to iframe via postMessage (animated markers)
  useEffect(() => {
    pushMarkers();
  }, [locations]);

  // Build the iframe HTML only once. Rebuilding it on every refresh would change
  // srcDoc and force a full reload that resets the zoom every 30s.
  const htmlContent = useMemo(() => buildMapHtml(process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? ""), []);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[s.root, { backgroundColor: colors.background, paddingTop: insets.top + 8 }]}>
        {/* Header */}
        <View style={[s.header, { borderBottomColor: colors.border, backgroundColor: colors.card }]}>
          <View style={[s.headerIcon, { backgroundColor: "#0891B218" }]}>
            <Feather name="map-pin" size={18} color="#0891B2" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.headerTitle, { color: colors.foreground }]}>Live Technician Map</Text>
            <Text style={[s.headerSub, { color: colors.mutedForeground }]}>
              {allLocs.length === 0
                ? "No technicians found"
                : `${allLocs.length} technician${allLocs.length > 1 ? "s" : ""} · refreshes every 30s`}
            </Text>
          </View>
          {isRefetching && (
            <ActivityIndicator size="small" color="#0891B2" style={{ marginRight: 8 }} />
          )}
          <TouchableOpacity onPress={onClose} style={s.closeBtn} activeOpacity={0.7}>
            <Feather name="x" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {isLoading && (
          <View style={s.centered}>
            <ActivityIndicator size="large" color="#0891B2" />
            <Text style={[s.loadingText, { color: colors.mutedForeground }]}>
              Loading locations…
            </Text>
          </View>
        )}

        {!isLoading && allLocs.length === 0 && (
          <View style={s.centered}>
            <Feather name="map" size={48} color={colors.mutedForeground} />
            <Text style={[s.emptyTitle, { color: colors.foreground }]}>No Technicians Found</Text>
            <Text style={[s.emptySub, { color: colors.mutedForeground }]}>
              No approved technicians in the system yet.
            </Text>
            <TouchableOpacity
              style={[s.retryBtn, { backgroundColor: "#0891B218", borderColor: "#0891B244" }]}
              onPress={() => refetch()}
              activeOpacity={0.85}
            >
              <Feather name="refresh-cw" size={14} color="#0891B2" />
              <Text style={[s.retryBtnText, { color: "#0891B2" }]}>Refresh</Text>
            </TouchableOpacity>
          </View>
        )}

        {!isLoading && (
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {/* Leaflet map in iframe — works on web, bypasses Metro bundling */}
            <View style={s.mapWrapper}>
              {/* @ts-ignore — iframe is a valid DOM element in Expo web */}
              <iframe
                key={mapKey}
                ref={iframeRef}
                srcDoc={htmlContent}
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  borderRadius: 0,
                  display: "block",
                }}
                onLoad={() => { mapReadyRef.current = true; pushMarkers(); }}
                title="Live Technician Map"
                sandbox="allow-scripts"
              />
              {/* LIVE badge overlay */}
              <View style={s.liveBadge}>
                <View style={s.liveDot} />
                <Text style={s.liveText}>LIVE</Text>
              </View>
            </View>

            {/* Tech cards below map — show ALL technicians */}
            {allLocs.length > 0 && (
              <View style={s.listContent}>
                {allLocs.map((loc, idx) => {
                  const pinColor = TECH_COLORS[idx % TECH_COLORS.length];
                  const lat = parseFloat(loc.latitude);
                  const lng = parseFloat(loc.longitude);
                  const hasCoords = !isNaN(lat) && !isNaN(lng);
                  const sColor = statusColor(loc.status);
                  return (
                    <View
                      key={loc.technicianId}
                      style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}
                    >
                      <View style={{ height: 4, backgroundColor: pinColor, borderTopLeftRadius: 14, borderTopRightRadius: 14 }} />
                      <View style={s.cardBody}>
                        <View style={[s.pinDot, { backgroundColor: pinColor + "22" }]}>
                          <Feather name="user" size={18} color={pinColor} />
                        </View>
                        <View style={{ flex: 1, gap: 3 }}>
                          <Text style={[s.techName, { color: colors.foreground }]}>{loc.name}</Text>
                          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                            {loc.checkInAt && (
                              <View style={[s.chip, { backgroundColor: colors.muted }]}>
                                <Feather name="log-in" size={10} color={colors.mutedForeground} />
                                <Text style={[s.chipText, { color: colors.mutedForeground }]}>
                                  In {formatTime(loc.checkInAt)}
                                </Text>
                              </View>
                            )}
                            <View style={[s.chip, { backgroundColor: sColor + "15" }]}>
                              <Feather name="radio" size={10} color={sColor} />
                              <Text style={[s.chipText, { color: sColor }]}>
                                {loc.recordedAt ? minutesAgo(loc.recordedAt) : "No ping yet"}
                              </Text>
                            </View>
                            {hasCoords && (
                              <View style={[s.chip, { backgroundColor: colors.muted }]}>
                                <Feather name="crosshair" size={10} color={colors.mutedForeground} />
                                <Text style={[s.chipText, { color: colors.mutedForeground }]}>
                                  {lat.toFixed(4)}, {lng.toFixed(4)}
                                </Text>
                              </View>
                            )}
                          </View>
                          {loc.address ? (
                            <Text
                              style={[s.address, { color: colors.mutedForeground }]}
                              numberOfLines={2}
                            >
                              📍 {loc.address}
                            </Text>
                          ) : null}
                        </View>
                        <View style={[s.activeBadge, { backgroundColor: sColor + "15", borderColor: sColor + "44" }]}>
                          <View style={[s.activeDot, { backgroundColor: sColor }]} />
                          <Text style={[s.activeBadgeText, { color: sColor }]}>
                            {statusLabel(loc.status)}
                          </Text>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </ScrollView>
        )}
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
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  loadingText: { fontSize: 14, fontFamily: "Inter_400Regular", marginTop: 8 },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_700Bold", textAlign: "center" },
  emptySub: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  retryBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1, marginTop: 4,
  },
  retryBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  mapWrapper: {
    marginHorizontal: 14,
    marginTop: 14,
    borderRadius: 16,
    overflow: "hidden",
    height: 360,
    borderWidth: 1,
    borderColor: "#0891B222",
  },
  liveBadge: {
    position: "absolute",
    top: 10,
    right: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
    zIndex: 1000,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#EF4444" },
  liveText: { color: "white", fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  listContent: { padding: 14, gap: 12 },
  card: {
    borderRadius: 16, borderWidth: 1,
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 6, elevation: 2, overflow: "hidden",
  },
  cardBody: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 14 },
  pinDot: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  techName: { fontSize: 15, fontFamily: "Inter_700Bold" },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20,
  },
  chipText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  address: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  activeBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20, borderWidth: 1, alignSelf: "flex-start",
  },
  activeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#10B981" },
  activeBadgeText: { fontSize: 10, fontFamily: "Inter_700Bold", color: "#10B981" },
});
