import React from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Platform,
} from "react-native";
import { Feather } from "@expo/vector-icons";

interface Props {
  visible: boolean;
  currentVersion: string;
  latestVersion: string;
  apkUrl: string;
  onDismiss: () => void;
}

export function UpdateModal({ visible, currentVersion, latestVersion, apkUrl, onDismiss }: Props) {
  if (Platform.OS === "web") return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Feather name="download-cloud" size={32} color="#FFFFFF" />
          </View>
          <Text style={styles.title}>Update Available</Text>
          <Text style={styles.subtitle}>
            A new version of K&S Solar is ready.
          </Text>
          <View style={styles.versionRow}>
            <View style={styles.versionBadge}>
              <Text style={styles.versionLabel}>Current</Text>
              <Text style={styles.versionValue}>v{currentVersion}</Text>
            </View>
            <Feather name="arrow-right" size={16} color="#94A3B8" style={{ marginHorizontal: 8 }} />
            <View style={[styles.versionBadge, styles.versionBadgeNew]}>
              <Text style={[styles.versionLabel, { color: "#16A34A" }]}>Latest</Text>
              <Text style={[styles.versionValue, { color: "#16A34A" }]}>v{latestVersion}</Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.downloadBtn}
            activeOpacity={0.85}
            onPress={() => {
              Linking.openURL(apkUrl).catch(() => {});
              onDismiss();
            }}
          >
            <Feather name="download" size={16} color="#FFFFFF" />
            <Text style={styles.downloadBtnText}>Download Update</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.dismissBtn} activeOpacity={0.7} onPress={onDismiss}>
            <Text style={styles.dismissBtnText}>Later</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 28,
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 12,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#22C55E",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#0F172A",
    marginBottom: 6,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748B",
    textAlign: "center",
    marginBottom: 20,
    lineHeight: 20,
  },
  versionRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 24,
  },
  versionBadge: {
    backgroundColor: "#F1F5F9",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: "center",
  },
  versionBadgeNew: {
    backgroundColor: "#F0FDF4",
  },
  versionLabel: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: "#64748B",
    marginBottom: 2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  versionValue: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#0F172A",
  },
  downloadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#22C55E",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    width: "100%",
    justifyContent: "center",
    marginBottom: 10,
  },
  downloadBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFFFFF",
  },
  dismissBtn: {
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  dismissBtnText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#94A3B8",
  },
});
