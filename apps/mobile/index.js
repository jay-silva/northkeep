/**
 * App entry. The Buffer polyfill MUST load before anything that touches
 * @northkeep/core (the vault code is written against Node's Buffer, and the
 * plan keeps it that way: "do NOT refactor shipped desktop code to Uint8Array";
 * Metro supplies the `buffer` package instead).
 */
import './src/polyfills';
import 'expo-router/entry';
