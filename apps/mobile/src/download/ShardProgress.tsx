// Animated shard visual for a download, matching the web widget: a row of shard
// cells that light up as each shard lands, a merged block growing behind them,
// and a small "ghost" per newly-landed shard flying from its slot into the
// centre where it is absorbed.
//
// Shard counts can be large; one View per shard would jank the list, so slots
// are capped and the completed count is scaled proportionally. The exact bytes
// are shown as text next to this, so the cap is purely a rendering trade.

import * as React from "react";
import {
  Animated,
  Easing,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { Progress, useTheme } from "../design";

const MAX_SLOTS = 24;
const FLY_MS = 650;
const GHOST_SIZE = 12;
const TRACK_HEIGHT = 24;

interface Ghost {
  id: number;
  startX: number;
  progress: Animated.Value;
}

interface ShardProgressProps {
  completed: number;
  total: number;
  status: "active" | "done" | "error";
  style?: StyleProp<ViewStyle>;
}

export function ShardProgress({ completed, total, status, style }: ShardProgressProps) {
  const theme = useTheme();
  const slots = Math.min(total > 0 ? total : 0, MAX_SLOTS);
  const filled = total > 0 ? Math.round((completed / total) * slots) : 0;
  const ratio = total > 0 ? Math.min(1, completed / total) : 0;
  const active = status === "active";

  const [width, setWidth] = React.useState(0);
  const [ghosts, setGhosts] = React.useState<Ghost[]>([]);
  const previous = React.useRef(filled);
  const nextId = React.useRef(0);

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  React.useEffect(() => {
    const before = previous.current;
    previous.current = filled;
    // Only animate transitions we can place on screen; the first measured layout
    // and any shrink (a new download resetting the bar) skip the flight.
    if (!active || width === 0 || filled <= before) return;

    const added: Ghost[] = [];
    for (let index = before; index < filled; index += 1) {
      const startX = ((index + 0.5) / slots) * width - GHOST_SIZE / 2;
      added.push({ id: nextId.current++, startX, progress: new Animated.Value(0) });
    }
    setGhosts((existing) => [...existing, ...added]);

    Animated.parallel(
      added.map((ghost) =>
        Animated.timing(ghost.progress, {
          toValue: 1,
          duration: FLY_MS,
          easing: Easing.out(Easing.cubic),
          // translateX + opacity are native-driver eligible, so the ghosts run
          // on the UI thread instead of competing with JS during a download.
          useNativeDriver: true,
        }),
      ),
    ).start(() => {
      const ids = new Set(added.map((ghost) => ghost.id));
      setGhosts((existing) => existing.filter((ghost) => !ids.has(ghost.id)));
    });
  }, [filled, active, width, slots]);

  // No shard count yet: fall back to the plain bar so the row still shows motion.
  if (slots === 0) return <Progress value={ratio} tone={theme.status.pending} />;

  return (
    <View onLayout={onLayout} style={[{ height: TRACK_HEIGHT }, style]}>
      {/* Merged block: grows from the centre as shards accumulate. */}
      <View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${(1 - ratio) * 50}%`,
          width: `${Math.max(ratio, 0.04) * 100}%`,
          borderRadius: theme.radius.sm,
          backgroundColor: theme.colors.accent,
          opacity: 0.85,
        }}
      />
      {/* Shard slots, scaled to the file's shard count. */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, flexDirection: "row", gap: 2 }}>
        {Array.from({ length: slots }, (_, index) => (
          <View
            key={index}
            style={{
              flex: 1,
              borderRadius: 3,
              borderWidth: 1,
              borderColor: index < filled ? theme.colors.accent : theme.colors.border,
              backgroundColor: index < filled ? `${theme.colors.accent}40` : "transparent",
            }}
          />
        ))}
      </View>
      {/* Landed shards fly into the merged block and fade. */}
      {ghosts.map((ghost) => (
        <Animated.View
          key={ghost.id}
          pointerEvents="none"
          style={{
            position: "absolute",
            top: (TRACK_HEIGHT - GHOST_SIZE) / 2,
            width: GHOST_SIZE,
            height: GHOST_SIZE,
            borderRadius: 3,
            backgroundColor: theme.colors.accent,
            transform: [
              {
                translateX: ghost.progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [ghost.startX, width / 2 - GHOST_SIZE / 2],
                }),
              },
            ],
            opacity: ghost.progress.interpolate({
              inputRange: [0, 0.7, 1],
              outputRange: [0, 1, 0],
            }),
          }}
        />
      ))}
    </View>
  );
}
