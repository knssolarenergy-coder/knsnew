import { Feather } from "@expo/vector-icons";
import React from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";

interface Props {
  visible: boolean;
  onClose: () => void;
  techId: string;
  techName: string;
}

export function TechTrailModal({ visible, onClose, techName }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[s.root, { backgroundColor: colors.background, paddingTop: insets.top + 10 }]}>
        <View style={[s.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose} style={s.closeBtn} activeOpacity={0.7}>
            <Feather name="arrow-left" size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[s.title, { color: colors.foreground }]}>{techName} — Trail</Text>
        </View>
        <View style={s.center}>
          <Feather name="map" size={48} color={colors.mutedForeground} />
          <Text style={[s.msg, { color: colors.foreground }]}>Map not available on web</Text>
          <Text style={[s.sub, { color: colors.mutedForeground }]}>
            Open this on the mobile app to view the technician trail.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 14, paddingBottom: 14, borderBottomWidth: 1,
  },
  closeBtn: { padding: 6 },
  title: { fontSize: 17, fontFamily: "Inter_700Bold", flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  msg: { fontSize: 17, fontFamily: "Inter_700Bold", textAlign: "center" },
  sub: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
});
