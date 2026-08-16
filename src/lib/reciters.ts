export type Reciter = {
  id: number;
  name: string;
  arabicName: string;
  style: "murattal" | "mujawwad" | "muallim";
};

export const RECITERS: Reciter[] = [
  { id: 7, name: "Mishary Rashid Al-Afasy", arabicName: "مشاري راشد العفاسي", style: "murattal" },
  { id: 3, name: "Abdul Rahman Al-Sudais", arabicName: "عبد الرحمن السديس", style: "murattal" },
  { id: 6, name: "Mahmoud Khalil Al-Husary", arabicName: "محمود خليل الحصري", style: "murattal" },
  { id: 12, name: "Al-Husary (Mu'allim — teaching)", arabicName: "الحصري — معلّم", style: "muallim" },
  { id: 9, name: "Mohamed Siddiq Al-Minshawi", arabicName: "محمد صديق المنشاوي", style: "murattal" },
  { id: 8, name: "Al-Minshawi (Mujawwad)", arabicName: "المنشاوي — مجوّد", style: "mujawwad" },
  { id: 2, name: "AbdulBaset AbdulSamad", arabicName: "عبد الباسط عبد الصمد", style: "murattal" },
  { id: 1, name: "AbdulBaset (Mujawwad)", arabicName: "عبد الباسط — مجوّد", style: "mujawwad" },
  { id: 4, name: "Abu Bakr Al-Shatri", arabicName: "أبو بكر الشاطري", style: "murattal" },
  { id: 5, name: "Hani Ar-Rifai", arabicName: "هاني الرفاعي", style: "murattal" },
  { id: 10, name: "Sa'ud Al-Shuraim", arabicName: "سعود الشريم", style: "murattal" },
  { id: 11, name: "Mohamed Al-Tablawi", arabicName: "محمد الطبلاوي", style: "murattal" },
];

export const DEFAULT_RECITER_ID = 7;

export function getReciter(id: number): Reciter {
  return RECITERS.find((r) => r.id === id) ?? RECITERS[0];
}
