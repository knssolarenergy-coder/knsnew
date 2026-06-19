import * as SecureStore from "expo-secure-store";
import * as Location from "expo-location";
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState, useCallback } from "react";
import {
  AppState,
  Linking,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "@/context/AuthContext";

const ATTENDANCE_KEY = "ks_solar_active_attendance";

export function LocationEnforcementOverlay() {
  const { user } = useAuth();
  const [blocked, setBlocked] = useState(false);

  const isTechnician = user && !user.isAdmin && user.role !== "admin";

  const check = useCallback(async () => {
    if (Platform.OS === "web") return;
    if (!isTechnician) { setBlocked(false); return; }
    try {
      const attendanceId = await SecureStore.getItemAsync(ATTENDANCE_KEY);
      if (!attendanceId) { setBlocked(false); return; }
      const enabled = await Location.hasServicesEnabledAsync();
      const { status } = await Location.getForegroundPermissionsAsync();
      setBlocked(!enabled || status !== "granted");
    } catch {
      setBlocked(false);
    }
  }, [isTechnician]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    check();
    const interval = setInterval(check, 3000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [check]);

  if (Platform.OS === "web" || !blocked) return null;

  return (
    <Modal visible animationType="fade" transparent={false} statusBarTranslucent>
      <View style={s.container}>
        <View style={s.iconWrap}>
          <Feather name="lock" size={44} color="#EF4444" />
        </View>

        <Text style={s.title}>Location Band Hai!</Text>
        <Text style={s.body}>
          {"Aap check-in ke doran location off nahi kar sakte.\n\nCheck-out karne tak location ON rakhna zaroori hai — warna aapki tracking ruk jaati hai."}
        </Text>

        <TouchableOpacity
          style={s.btn}
          onPress={() => Linking.openSettings()}
          activeOpacity={0.85}
        >
          <Feather name="settings" size={18} color="#fff" />
          <Text style={s.btnText}>Settings Mein Jayen</Text>
        </TouchableOpacity>

        <Text style={s.hint}>Location on karte hi yeh screen khud band ho jaegi</Text>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    justifyContent: "center",
    alignItems: "center",
    padding: 36,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#FEE2E2",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 28,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: "#1E293B",
    textAlign: "center",
    marginBottom: 14,
  },
  body: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748B",
    textAlign: "center",
    lineHeight: 26,
    marginBottom: 36,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#0C4A6E",
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 32,
    width: "100%",
    justifyContent: "center",
  },
  btnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  hint: {
    fontSize: 12,
    color: "#94A3B8",
    textAlign: "center",
    marginTop: 20,
    fontFamily: "Inter_400Regular",
  },
});
