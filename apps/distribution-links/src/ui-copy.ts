import type { TrackedLinkRecord } from "@satsang/distribution-domain";
type Copy = { continue: string; alternative: string; unavailable: string };
const copy: Record<TrackedLinkRecord["language"], Copy> = {
  en: {
    continue: "Continue",
    alternative: "Another practice is available.",
    unavailable: "This invitation is unavailable.",
  },
  hi: {
    continue: "आगे बढ़ें",
    alternative: "एक और साधना उपलब्ध है।",
    unavailable: "यह निमंत्रण उपलब्ध नहीं है।",
  },
  te: {
    continue: "కొనసాగించండి",
    alternative: "మరొక సాధన అందుబాటులో ఉంది.",
    unavailable: "ఈ ఆహ్వానం అందుబాటులో లేదు.",
  },
  kn: { continue: "ಮುಂದುವರಿಸಿ", alternative: "ಮತ್ತೊಂದು ಸಾಧನೆ ಲಭ್ಯವಿದೆ.", unavailable: "ಈ ಆಹ್ವಾನ ಲಭ್ಯವಿಲ್ಲ." },
  ta: {
    continue: "தொடரவும்",
    alternative: "மற்றொரு பயிற்சி உள்ளது.",
    unavailable: "இந்த அழைப்பு கிடைக்கவில்லை.",
  },
  ml: { continue: "തുടരുക", alternative: "മറ്റൊരു സാധന ലഭ്യമാണ്.", unavailable: "ഈ ക്ഷണം ലഭ്യമല്ല." },
  gu: {
    continue: "આગળ વધો",
    alternative: "બીજી સાધના ઉપલબ્ધ છે.",
    unavailable: "આ આમંત્રણ ઉપલબ્ધ નથી.",
  },
};
export const linkCopy = (language: TrackedLinkRecord["language"]) => copy[language];
