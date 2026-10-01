/**
 * Segmentos atendidos. O segmento personaliza vocabulário do painel, tom do
 * agente e serviços sugeridos no cadastro. O código continua neutro.
 */

export const SEGMENTS = [
  "barbershop",
  "salon",
  "aesthetics",
  "tattoo",
  "pet_shop",
  "clinic",
  "other",
] as const;
export type Segment = (typeof SEGMENTS)[number];

export interface SuggestedService {
  name: string;
  durationMinutes: number;
  priceCents: number;
}

export interface SegmentProfile {
  segment: Segment;
  labels: {
    /** Como o negócio é chamado: "barbearia", "salão"... */
    business: string;
    /** Gênero gramatical de `business`, para concordância: "uma barbearia", "um salão". */
    gender: "f" | "m";
    professional: string;
    professionals: string;
  };
  agent: {
    /** Trecho do prompt que define o tom da conversa. */
    tone: string;
    /** Regras extras que só valem para o segmento. */
    rules: string[];
  };
  suggestedServices: SuggestedService[];
}

const profiles: Record<Segment, SegmentProfile> = {
  barbershop: {
    segment: "barbershop",
    labels: {
      business: "barbearia",
      gender: "f",
      professional: "barbeiro",
      professionals: "barbeiros",
    },
    agent: {
      tone: "Descontraído e direto, como o atendente de uma barbearia de bairro. Pode usar gírias leves como fechou e tranquilo, sem exagero.",
      rules: [],
    },
    suggestedServices: [
      { name: "Corte", durationMinutes: 30, priceCents: 4500 },
      { name: "Barba", durationMinutes: 30, priceCents: 3500 },
      { name: "Corte e barba", durationMinutes: 60, priceCents: 7500 },
      { name: "Acabamento", durationMinutes: 15, priceCents: 1500 },
      { name: "Sobrancelha", durationMinutes: 15, priceCents: 1500 },
    ],
  },
  salon: {
    segment: "salon",
    labels: {
      business: "salão",
      gender: "m",
      professional: "profissional",
      professionals: "profissionais",
    },
    agent: {
      tone: "Simpático e acolhedor, com linguagem leve.",
      rules: [],
    },
    suggestedServices: [
      { name: "Corte feminino", durationMinutes: 60, priceCents: 9000 },
      { name: "Escova", durationMinutes: 45, priceCents: 6000 },
      { name: "Coloração", durationMinutes: 120, priceCents: 18000 },
      { name: "Manicure", durationMinutes: 45, priceCents: 4000 },
      { name: "Pedicure", durationMinutes: 45, priceCents: 4500 },
    ],
  },
  aesthetics: {
    segment: "aesthetics",
    labels: {
      business: "clínica de estética",
      gender: "f",
      professional: "profissional",
      professionals: "profissionais",
    },
    agent: {
      tone: "Cordial e cuidadoso.",
      rules: ["Não prometa resultado de procedimento."],
    },
    suggestedServices: [
      { name: "Limpeza de pele", durationMinutes: 60, priceCents: 15000 },
      { name: "Design de sobrancelha", durationMinutes: 30, priceCents: 5000 },
      { name: "Depilação", durationMinutes: 30, priceCents: 6000 },
      { name: "Massagem relaxante", durationMinutes: 60, priceCents: 14000 },
    ],
  },
  tattoo: {
    segment: "tattoo",
    labels: {
      business: "estúdio de tatuagem",
      gender: "m",
      professional: "tatuador",
      professionals: "tatuadores",
    },
    agent: {
      tone: "Descontraído e direto.",
      rules: [
        "Preço de tatuagem nova depende de tamanho, local e arte. Não informe valor: ofereça uma avaliação ou encaminhe para um humano.",
      ],
    },
    suggestedServices: [
      { name: "Avaliação", durationMinutes: 30, priceCents: 0 },
      { name: "Sessão de tatuagem", durationMinutes: 180, priceCents: 40000 },
    ],
  },
  pet_shop: {
    segment: "pet_shop",
    labels: {
      business: "pet shop",
      gender: "m",
      professional: "profissional",
      professionals: "profissionais",
    },
    agent: {
      tone: "Carinhoso e animado.",
      rules: [
        "Antes de propor o horário, pergunte o nome e o porte do pet e registre nas observações do agendamento.",
      ],
    },
    suggestedServices: [
      { name: "Banho", durationMinutes: 60, priceCents: 6000 },
      { name: "Banho e tosa", durationMinutes: 90, priceCents: 9000 },
      { name: "Tosa higiênica", durationMinutes: 45, priceCents: 5000 },
    ],
  },
  clinic: {
    segment: "clinic",
    labels: {
      business: "clínica",
      gender: "f",
      professional: "profissional",
      professionals: "profissionais",
    },
    agent: {
      tone: "Cordial, respeitoso e objetivo.",
      rules: [
        "Nunca pergunte sintomas, diagnóstico, motivo da consulta ou qualquer dado de saúde. Se o cliente contar, não repita nem registre.",
        "Não dê orientação médica. Em urgência, oriente procurar atendimento de emergência pelo SAMU 192.",
      ],
    },
    suggestedServices: [
      { name: "Consulta", durationMinutes: 30, priceCents: 20000 },
      { name: "Retorno", durationMinutes: 20, priceCents: 0 },
    ],
  },
  other: {
    segment: "other",
    labels: {
      business: "estabelecimento",
      gender: "m",
      professional: "profissional",
      professionals: "profissionais",
    },
    agent: {
      tone: "Simpático e objetivo.",
      rules: [],
    },
    suggestedServices: [],
  },
};

export function getSegmentProfile(segment: Segment): SegmentProfile {
  return profiles[segment];
}
