import React from 'react';

type SegmentedValue = string | number;

export type SegmentedOption<T extends SegmentedValue> = {
    value: T;
    label: string;
    title?: string;
};

type SegmentedControlProps<T extends SegmentedValue> = {
    value: T;
    options: Array<SegmentedOption<T>>;
    onChange: (value: T) => void;
    disabled?: boolean;
    ariaLabel?: string;
    minWidth?: number;
};

export function SegmentedControl<T extends SegmentedValue>({
    value,
    options,
    onChange,
    disabled = false,
    ariaLabel,
    minWidth,
}: SegmentedControlProps<T>) {
    const activeIndex = Math.max(0, options.findIndex(option => option.value === value));
    const count = Math.max(1, options.length);

    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            style={{
                position: 'relative',
                minHeight: 34,
                minWidth,
                display: 'grid',
                gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
                alignItems: 'stretch',
                gap: 0,
                padding: 2,
                borderRadius: 999,
                border: '1px solid #d9dde4',
                background: 'rgba(255,255,255,0.58)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.75)',
                overflow: 'hidden',
                boxSizing: 'border-box',
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    position: 'absolute',
                    top: 2,
                    bottom: 2,
                    left: 2,
                    width: `calc((100% - 4px) / ${count})`,
                    borderRadius: 999,
                    background: '#fff',
                    border: '1px solid rgba(0,0,0,0.06)',
                    boxShadow: '0 6px 16px rgba(15,23,42,0.10), inset 0 1px 0 rgba(255,255,255,0.95)',
                    transform: `translateX(${activeIndex * 100}%)`,
                    transition: 'transform 280ms cubic-bezier(.22,1,.36,1)',
                    pointerEvents: 'none',
                    zIndex: 0,
                }}
            />
            {options.map(option => {
                const active = option.value === value;
                return (
                    <button
                        key={String(option.value)}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabled}
                        title={option.title}
                        onClick={() => onChange(option.value)}
                        style={{
                            position: 'relative',
                            zIndex: 1,
                            minHeight: 28,
                            border: 'none',
                            background: 'transparent',
                            color: active ? '#111113' : '#6f737c',
                            cursor: disabled ? 'not-allowed' : 'pointer',
                            padding: '0 14px',
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: active ? 760 : 680,
                            lineHeight: 1,
                            textAlign: 'center',
                            whiteSpace: 'nowrap',
                            opacity: disabled ? 0.58 : 1,
                            transition: 'color 200ms ease, opacity 160ms ease',
                        }}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
