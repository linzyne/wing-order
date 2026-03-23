import React from 'react';

export const DragHandleContext = React.createContext<{
    attributes: Record<string, any>;
    listeners: Record<string, any> | undefined;
}>({ attributes: {}, listeners: undefined });
