import { X } from 'lucide-react';

interface SkillChipsProps {
  skills: { name: string }[];
  onRemove: (name: string) => void;
}

export function SkillChips({ skills, onRemove }: SkillChipsProps) {
  if (skills.length === 0) return null;

  return (
    <>
      {skills.map((skill) => (
        <span
          key={skill.name}
          className="inline-flex items-center gap-1 rounded-lg bg-tint-muted px-2 py-1 text-xs font-medium text-tint"
        >
          <span>{skill.name}</span>
          <button
            type="button"
            onClick={() => onRemove(skill.name)}
            className="rounded-sm p-0.5 hover:bg-tint/20 transition-colors"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
    </>
  );
}
