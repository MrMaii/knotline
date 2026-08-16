import { createContext, useContext, type ReactNode } from "react";

export type KnotlineLanguage = "zh" | "en";

interface KnotlineI18n {
  language: KnotlineLanguage;
  locale: "zh-CN" | "en";
  text: (chinese: string, english: string) => string;
}

const I18N: Record<KnotlineLanguage, KnotlineI18n> = {
  zh: {
    language: "zh",
    locale: "zh-CN",
    text: (chinese) => chinese,
  },
  en: {
    language: "en",
    locale: "en",
    text: (_chinese, english) => english,
  },
};

const KnotlineLanguageContext = createContext<KnotlineLanguage>("en");

export function resolveKnotlineLanguage(value: string | null | undefined): KnotlineLanguage {
  const normalized = value?.trim().replaceAll("_", "-").toLowerCase() ?? "";
  return normalized === "zh" || normalized.startsWith("zh-") ? "zh" : "en";
}

export function getKnotlineI18n(language: KnotlineLanguage): KnotlineI18n {
  return I18N[language];
}

export function KnotlineLanguageProvider({
  language,
  children,
}: {
  language: KnotlineLanguage;
  children: ReactNode;
}) {
  return (
    <KnotlineLanguageContext.Provider value={language}>
      {children}
    </KnotlineLanguageContext.Provider>
  );
}

export function useKnotlineI18n(): KnotlineI18n {
  return I18N[useContext(KnotlineLanguageContext)];
}
