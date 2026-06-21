import { Feather } from "@expo/vector-icons";
import {
  useGetAttendance,
  useGetLocationTrail,
  useGetTechnicianLiveLocations,
} from "@workspace/api-client-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";

const TECH_COLORS = [
  "#3B82F6", "#10B981", "#8B5CF6", "#F59E0B",
  "#EF4444", "#06B6D4", "#EC4899", "#84CC16",
];

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true }); }
  catch { return iso; }
}

function minutesAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diff < 1) return "just now";
  if (diff === 1) return "1 min ago";
  if (diff < 60) return `${diff} min ago`;
  return `${Math.floor(diff / 60)}h ${diff % 60}m ago`;
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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #F8FAFC; }
    #map { width: 100vw; height: 100vh; }
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
    if(!e.data) return;
    if(e.data.type==='UPDATE_MARKERS') { fitView(setMarkers(e.data.markers)); }
    else if(e.data.type==='SHOW_TRAIL') {
      if(map.getSource('trail')) { try{map.removeLayer('trail-line');}catch(e){} map.removeSource('trail'); }
      if(e.data.latlngs&&e.data.latlngs.length>0) {
        var coords=e.data.latlngs.map(function(ll){return[ll[1],ll[0]];});
        map.addSource('trail',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:coords}}});
        map.addLayer({id:'trail-line',type:'line',source:'trail',paint:{'line-color':e.data.color||'#3B82F6','line-width':4,'line-opacity':0.8}});
        map.flyTo({center:coords[coords.length-1],zoom:Math.max(map.getZoom(),14)});
      }
    } else if(e.data.type==='CLEAR_TRAIL') {
      if(map.getSource('trail')) { try{map.removeLayer('trail-line');}catch(e){} map.removeSource('trail'); }
    }
  });
})();
</script>
</body>
</html>`;
}

export function LiveMapSection() {
  const colors = useColors();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mapReadyRef = useRef(false);
  const [mapKey] = useState(0);
  const [selectedTechId, setSelectedTechId] = useState<string | null>(null);
  const selectedColorRef = useRef<string>("#3B82F6");
  const locsRef = useRef<Array<{ id: string; lat: number; lng: number; name: string; color: string; status: string; checkInAt: string | null | undefined; recordedAt: string; address: string }>>([]);

  const today = useMemo(() => new Date().toISOString().split("T")[0], []);

  const { data: locations, isRefetching, isLoading } = useGetTechnicianLiveLocations({
    query: { queryKey: ["tech-live-section"], refetchInterval: 30_000 },
  });

  const { data: todayAttendance } = useGetAttendance(
    { date: today, technicianId: selectedTechId ?? undefined },
    { query: { queryKey: ["attendance-today-section", today, selectedTechId], enabled: !!selectedTechId } }
  );

  const selectedAttendanceId = useMemo(() => {
    if (!selectedTechId || !todayAttendance) return null;
    return todayAttendance.find(r => !r.checkOutAt)?.id ?? null;
  }, [selectedTechId, todayAttendance]);

  const { data: trail, isLoading: trailLoading } = useGetLocationTrail(
    selectedAttendanceId ?? "",
    { query: { queryKey: ["trail-section", selectedAttendanceId], enabled: !!selectedAttendanceId } }
  );

  const locs = useMemo(() => (
    (locations ?? []).filter(l => !isNaN(parseFloat(l.latitude)) && !isNaN(parseFloat(l.longitude)))
  ), [locations]);

  function buildPayload() {
    return locs.map((loc, idx) => ({
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
  }
  locsRef.current = buildPayload();

  function pushMarkers() {
    if (!mapReadyRef.current) return;
    iframeRef.current?.contentWindow?.postMessage({ type: "UPDATE_MARKERS", markers: locsRef.current }, "*");
  }

  useEffect(() => { pushMarkers(); }, [locations]);

  useEffect(() => {
    if (!mapReadyRef.current) return;
    if (!selectedTechId) {
      iframeRef.current?.contentWindow?.postMessage({ type: "CLEAR_TRAIL" }, "*");
      return;
    }
    if (!trail || trail.length === 0) return;
    const valid = trail.filter(p => !isNaN(parseFloat(p.latitude)) && !isNaN(parseFloat(p.longitude)));
    const latlngs = valid.map(p => [parseFloat(p.latitude), parseFloat(p.longitude)]);
    iframeRef.current?.contentWindow?.postMessage({ type: "SHOW_TRAIL", latlngs, color: selectedColorRef.current }, "*");
  }, [trail, selectedTechId]);

  const htmlContent = useMemo(() => buildMapHtml(process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? ""), []);

  return (
    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
      <View style={[s.mapWrapper, { borderColor: colors.border }]}>
        {/* @ts-ignore — iframe is valid DOM element in Expo web */}
        <iframe
          key={mapKey}
          ref={iframeRef}
          srcDoc={htmlContent}
          style={{ width: "100%", height: "100%", border: "none", borderRadius: 0, display: "block" }}
          onLoad={() => { mapReadyRef.current = true; pushMarkers(); }}
          title="Live Technician Map"
          sandbox="allow-scripts"
        />
        <View style={s.liveBadge}>
          <View style={s.liveDot} />
          <Text style={s.liveText}>{isRefetching ? "UPDATING" : "LIVE"}</Text>
        </View>
      </View>

      {isLoading && (
        <View style={s.centered}>
          <ActivityIndicator size="large" color="#0891B2" />
          <Text style={[s.loadingText, { color: colors.mutedForeground }]}>Loading locations…</Text>
        </View>
      )}

      {!isLoading && locs.length === 0 && (
        <View style={[s.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="map" size={32} color={colors.mutedForeground} />
          <Text style={[s.emptyTitle, { color: colors.foreground }]}>No Active Technicians</Text>
          <Text style={[s.emptySub, { color: colors.mutedForeground }]}>
            Technicians appear here after check-in and first location ping.
          </Text>
        </View>
      )}

      {!isLoading && locs.length > 0 && (
        <View style={s.listContent}>
          <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>
            {locs.length} Technician{locs.length > 1 ? "s" : ""} Online · tap to view trail
          </Text>
          {locs.map((loc, idx) => {
            const pinColor = TECH_COLORS[idx % TECH_COLORS.length];
            const lat = parseFloat(loc.latitude);
            const lng = parseFloat(loc.longitude);
            const isSelected = selectedTechId === loc.technicianId;
            return (
              <TouchableOpacity
                key={loc.technicianId}
                style={[s.card, { backgroundColor: colors.card, borderColor: isSelected ? pinColor : colors.border }]}
                onPress={() => {
                  if (isSelected) {
                    setSelectedTechId(null);
                    selectedColorRef.current = "#3B82F6";
                    if (mapReadyRef.current) iframeRef.current?.contentWindow?.postMessage({ type: "CLEAR_TRAIL" }, "*");
                  } else {
                    setSelectedTechId(loc.technicianId);
                    selectedColorRef.current = pinColor;
                    if (mapReadyRef.current) iframeRef.current?.contentWindow?.postMessage({ type: "CLEAR_TRAIL" }, "*");
                  }
                }}
                activeOpacity={0.85}
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
                        <Text style={[s.chipText, { color: colors.mutedForeground }]}>In {formatTime(loc.checkInAt ?? "")}</Text>
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
                  <View style={[s.activeBadge, {
                    backgroundColor: isSelected ? pinColor + "22" : "#10B98115",
                    borderColor: isSelected ? pinColor + "66" : "#10B98144",
                  }]}>
                    <View style={[s.activeDot, { backgroundColor: isSelected ? pinColor : "#10B981" }]} />
                    <Text style={[s.activeBadgeText, { color: isSelected ? pinColor : "#10B981" }]}>
                      {isSelected ? "Selected" : loc.status.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                    </Text>
                  </View>
                </View>

                {isSelected && (
                  <View style={{ borderTopWidth: 1, borderTopColor: pinColor + "33", paddingHorizontal: 14, paddingTop: 10, paddingBottom: 14 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <Feather name="map-pin" size={12} color={pinColor} />
                      <Text style={{ fontSize: 11, fontFamily: "Inter_700Bold", color: pinColor, textTransform: "uppercase", letterSpacing: 0.5 }}>
                        Location Trail
                      </Text>
                    </View>
                    {trailLoading ? (
                      <ActivityIndicator size="small" color={pinColor} style={{ marginVertical: 8 }} />
                    ) : !selectedAttendanceId ? (
                      <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: colors.mutedForeground }}>
                        Could not find today's session record
                      </Text>
                    ) : !trail || trail.length === 0 ? (
                      <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: colors.mutedForeground }}>
                        No location pings yet for this session
                      </Text>
                    ) : (
                      trail.map((ping, pingIdx) => {
                        const isLatest = pingIdx === trail.length - 1;
                        const pingTime = new Date(ping.recordedAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
                        const mapsUrl = `https://maps.google.com/?q=${ping.latitude},${ping.longitude}`;
                        return (
                          <View key={ping.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                            <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: isLatest ? "#10B981" : pinColor, marginTop: 4 }} />
                            <View style={{ flex: 1 }}>
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 1 }}>
                                <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: colors.foreground }}>{pingTime}</Text>
                                {isLatest && (
                                  <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, backgroundColor: "#10B98122", borderWidth: 1, borderColor: "#10B98144" }}>
                                    <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: "#10B981" }}>LIVE</Text>
                                  </View>
                                )}
                              </View>
                              <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: colors.mutedForeground, marginBottom: 2 }} numberOfLines={2}>
                                {ping.address || `${ping.latitude}, ${ping.longitude}`}
                              </Text>
                              <TouchableOpacity onPress={() => Linking.openURL(mapsUrl)} activeOpacity={0.7}>
                                <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: "#0891B2", textDecorationLine: "underline" }}>Open in Maps</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        );
                      })
                    )}
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  mapWrapper: { marginHorizontal: 14, marginTop: 14, borderRadius: 16, overflow: "hidden", height: 340, borderWidth: 1, borderColor: "#0891B222" },
  liveBadge: { position: "absolute", top: 10, right: 10, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(0,0,0,0.72)", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, zIndex: 1000 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#EF4444" },
  liveText: { color: "white", fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  centered: { alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  loadingText: { fontSize: 14, fontFamily: "Inter_400Regular", marginTop: 8 },
  emptyCard: { margin: 14, marginTop: 14, borderRadius: 16, borderWidth: 1, alignItems: "center", padding: 32, gap: 10 },
  emptyTitle: { fontSize: 17, fontFamily: "Inter_700Bold", textAlign: "center" },
  emptySub: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  listContent: { padding: 14, gap: 0 },
  sectionLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", paddingTop: 4, paddingBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  card: { marginBottom: 10, borderRadius: 14, borderWidth: 1.5, overflow: "hidden" },
  cardBody: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 14 },
  avatar: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 18, fontFamily: "Inter_700Bold" },
  techName: { fontSize: 15, fontFamily: "Inter_700Bold" },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20 },
  chipText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  address: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  activeBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20, borderWidth: 1, alignSelf: "flex-start" },
  activeDot: { width: 6, height: 6, borderRadius: 3 },
  activeBadgeText: { fontSize: 10, fontFamily: "Inter_700Bold" },
});
