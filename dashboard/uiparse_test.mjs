import { createParser, createLibrary, defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const Heading = defineComponent({ name: "Heading", description: "h", props: z.object({ text: z.string(), level: z.number().optional() }), component: () => null });
const KeyValues = defineComponent({ name: "KeyValues", description: "kv", props: z.object({ items: z.array(z.object({ label: z.string(), value: z.string() })) }), component: () => null });
const Callout = defineComponent({ name: "Callout", description: "c", props: z.object({ text: z.string(), tone: z.string().optional() }), component: () => null });
const Root = defineComponent({ name: "Root", description: "root", props: z.object({ children: z.array(z.any()), title: z.string().optional() }), component: () => null });

const lib = createLibrary({ components: [Root, Heading, KeyValues, Callout], root: "Root", id: "test" });
const parser = createParser(lib.toJSONSchema(), lib.root);

const text = '```\nroot = Root([heading, now, forecast, rain], "Ottawa Weather — Oct 10, 00:30 EDT")\nheading = Heading("Current conditions", 2)\nnow = KeyValues([row1, row2, row3, row4, row5, row6])\nrow1 = {label: "Temperature", value: "3.6 °C (feels like 0.7 °C)"}\nrow2 = {label: "Sky", value: "Clear ☀️"}\nrow3 = {label: "Humidity", value: "84%"}\nrow4 = {label: "Wind", value: "W 6.5 km/h"}\nrow5 = {label: "Pressure", value: "1025.5 hPa"}\nrow6 = {label: "Cloud cover", value: "0%"}\nforecast = KeyValues([f1, f2, f3], "3-day outlook")\nf1 = {label: "Sat Oct 10", value: "Partly cloudy · 12.4 / 1.5 °C · rain 2%"}\nf2 = {label: "Sun Oct 11", value: "Overcast · 18.9 / 3.4 °C · rain 16%"}\nf3 = {label: "Mon Oct 12", value: "Overcast · 20.4 / 11.9 °C · rain 70%"}\nrain = Callout("Monday\'s looking wet — 70% chance of rain for Thanksgiving. Plan the turkey indoors.", "warning")\n```\n\nLive from Open-Meteo, sir. A clear, cold night — mild, dry weekend ahead, rain arriving Monday.';

const result = parser.parse(text);
console.log("has root:", !!result.root);
console.log("incomplete:", result.meta.incomplete);
console.log("errors:", JSON.stringify(result.meta.errors));
console.log("unresolved:", JSON.stringify(result.meta.unresolved));
console.log("root type:", result.root?.typeName);