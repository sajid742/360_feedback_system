import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export interface EChartClickParams {
  name: string;
  seriesName?: string;
  dataIndex: number;
  value: unknown;
}

/**
 * Minimal React wrapper around Apache ECharts (DECISIONS.md).
 *
 * The chart instance is created ONCE per mount and updated through setOption.
 * Widgets build their `option` object inline on every render, so its identity
 * changes whenever the parent re-renders. The previous version listed `option`
 * in the same effect that called init/dispose, which tore the entire chart down
 * and rebuilt it on every parent render — discarding animation and tooltip
 * state, and doing far more work than a dashboard of a dozen charts can afford.
 *
 * `notMerge: true` matters now that a widget can switch chart family: merging a
 * radar option into a chart that previously drew bars would leave the old
 * cartesian axes behind.
 *
 * Resize is observed on the CONTAINER, not only the window. Dashboard widgets
 * are resized by changing their grid column span, which never fires a window
 * resize event — so a widget resized in the layout editor used to keep its old
 * width until something else forced a reflow.
 */
export function EChart({
  option,
  height = 360,
  onClick,
}: {
  option: echarts.EChartsOption;
  height?: number;
  onClick?: (params: EChartClickParams) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  // Create and destroy with the component — never with the option object.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const chart = echarts.init(el);
    chartRef.current = chart;

    chart.on('click', (params) => {
      clickRef.current?.({
        name: (params as { name: string }).name,
        seriesName: (params as { seriesName?: string }).seriesName,
        dataIndex: (params as { dataIndex: number }).dataIndex,
        value: (params as { value: unknown }).value,
      });
    });

    const resize = (): void => chart.resize();
    window.addEventListener('resize', resize);

    // Guarded: ResizeObserver exists in every browser this app targets, but not
    // in every test environment.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(el);

    return () => {
      window.removeEventListener('resize', resize);
      ro?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // Apply the option on every change, without recreating the instance.
  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  // ECharts caches the canvas size, so a height change needs an explicit resize.
  useEffect(() => {
    chartRef.current?.resize();
  }, [height]);

  return <div ref={ref} style={{ height, width: '100%', cursor: onClick ? 'pointer' : 'default' }} />;
}
