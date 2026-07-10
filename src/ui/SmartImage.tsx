import React, { useEffect, useState } from 'react';
import { resolveToDataUrl } from '../storage/images';

type SmartImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
    src: string;
};

export function SmartImage({ src, style, ...props }: SmartImageProps) {
    const [resolved, setResolved] = useState(src);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        setFailed(false);
        setResolved(src);
        resolveToDataUrl(src).then(value => {
            if (alive) setResolved(value || src);
        }).catch(() => {
            if (alive) setResolved(src);
        });
        return () => { alive = false; };
    }, [src]);

    return (
        <img
            {...props}
            src={resolved}
            onError={event => {
                setFailed(true);
                props.onError?.(event);
            }}
            style={{
                ...style,
                background: failed ? '#f4f4f5' : style?.background,
            }}
        />
    );
}
