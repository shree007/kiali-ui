import * as React from 'react';
import { bindActionCreators } from 'redux';
import { connect } from 'react-redux';
import { ThunkDispatch } from 'redux-thunk';
import { RouteComponentProps } from 'react-router-dom';
import FlexView from 'react-flexview';
import { style } from 'typestyle';
import { store } from '../../store/ConfigStore';
import { DurationInSeconds, TimeInMilliseconds } from '../../types/Common';
import Namespace from '../../types/Namespace';
import { EdgeLabelMode, GraphType, Layout, NodeParamsType, NodeType, SummaryData, UNKNOWN } from '../../types/Graph';
import { computePrometheusRateParams } from '../../services/Prometheus';
import * as AlertUtils from '../../utils/AlertUtils';
import CytoscapeGraphContainer from '../../components/CytoscapeGraph/CytoscapeGraph';
import CytoscapeToolbarContainer from '../../components/CytoscapeGraph/CytoscapeToolbar';
import ErrorBoundary from '../../components/ErrorBoundary/ErrorBoundary';
import GraphToolbarContainer from './GraphToolbar/GraphToolbar';
import GraphLegend from './GraphLegend';
import EmptyGraphLayoutContainer from '../../components/EmptyGraphLayout';
import SummaryPanel from './SummaryPanel';
import {
  activeNamespacesSelector,
  durationSelector,
  edgeLabelModeSelector,
  graphTypeSelector,
  lastRefreshAtSelector,
  meshWideMTLSEnabledSelector,
  replayActiveSelector,
  replayQueryTimeSelector
} from '../../store/Selectors';
import { KialiAppState } from '../../store/Store';
import { KialiAppAction } from '../../actions/KialiAppAction';
import { GraphActions } from '../../actions/GraphActions';
import { GraphToolbarActions } from '../../actions/GraphToolbarActions';
import { NodeContextMenuContainer } from '../../components/CytoscapeGraph/ContextMenu/NodeContextMenu';
import { PfColors, PFKialiColor } from 'components/Pf/PfColors';
import { TourActions } from 'actions/TourActions';
import TourStopContainer, { getNextTourStop, TourInfo } from 'components/Tour/TourStop';
import { arrayEquals } from 'utils/Common';
import { isKioskMode, getFocusSelector, unsetFocusSelector } from 'utils/SearchParamUtils';
import GraphTour, { GraphTourStops } from './GraphHelpTour';
import { Badge, Chip } from '@patternfly/react-core';
import { toRangeString } from 'components/Time/Utils';
import { replayBorder } from 'components/Time/Replay';
import GraphDataSource from '../../services/GraphDataSource';

// GraphURLPathProps holds path variable values.  Currenly all path variables are relevant only to a node graph
type GraphURLPathProps = {
  app: string;
  namespace: string;
  service: string;
  version: string;
  workload: string;
};

type ReduxProps = {
  activeNamespaces: Namespace[];
  activeTour?: TourInfo;
  duration: DurationInSeconds; // current duration (dropdown) setting
  edgeLabelMode: EdgeLabelMode;
  graphType: GraphType;
  isPageVisible: boolean;
  lastRefreshAt: TimeInMilliseconds;
  layout: Layout;
  node?: NodeParamsType;
  replayActive: boolean;
  replayQueryTime: TimeInMilliseconds;
  showLegend: boolean;
  showSecurity: boolean;
  showServiceNodes: boolean;
  showUnusedNodes: boolean;
  summaryData: SummaryData | null;
  mtlsEnabled: boolean;

  graphChanged: () => void;
  setNode: (node?: NodeParamsType) => void;
  toggleLegend: () => void;
  endTour: () => void;
  startTour: ({ info: TourInfo, stop: number }) => void;
};

export type GraphPageProps = RouteComponentProps<Partial<GraphURLPathProps>> & ReduxProps;

const NUMBER_OF_DATAPOINTS = 30;

const containerStyle = style({
  minHeight: '350px',
  // TODO: try flexbox to remove this calc
  height: 'calc(100vh - 113px)' // View height minus top bar height minus secondary masthead
});

const kioskContainerStyle = style({
  minHeight: '350px',
  height: 'calc(100vh - 10px)' // View height minus top bar height
});

const cytoscapeGraphContainerStyle = style({ flex: '1', minWidth: '350px', zIndex: 0, paddingRight: '5px' });
const cytoscapeGraphWrapperDivStyle = style({ position: 'relative', backgroundColor: PfColors.GrayBackground });
const cytoscapeToolbarWrapperDivStyle = style({
  position: 'absolute',
  bottom: '10px',
  zIndex: 2,
  borderStyle: 'hidden'
});

const graphTimeRangeDivStyle = style({
  position: 'absolute',
  top: '10px',
  left: '10px',
  width: 'auto',
  zIndex: 2,
  backgroundColor: PfColors.White
});

const whiteBackground = style({
  backgroundColor: PfColors.White
});

const replayBackground = style({
  backgroundColor: PFKialiColor.Replay
});

const graphLegendStyle = style({
  right: '0',
  bottom: '10px',
  position: 'absolute',
  overflow: 'hidden'
});

const GraphErrorBoundaryFallback = () => {
  return (
    <div className={cytoscapeGraphContainerStyle}>
      <EmptyGraphLayoutContainer namespaces={[]} isError={true} />
    </div>
  );
};

export class GraphPage extends React.Component<GraphPageProps> {
  private readonly errorBoundaryRef: any;
  private cytoscapeGraphRef: any;
  private focusSelector?: string;
  private graphDataSource: GraphDataSource;

  static getNodeParamsFromProps(props: RouteComponentProps<Partial<GraphURLPathProps>>): NodeParamsType | undefined {
    const app = props.match.params.app;
    const appOk = app && app !== UNKNOWN && app !== 'undefined';
    const namespace = props.match.params.namespace;
    const namespaceOk = namespace && namespace !== UNKNOWN && namespace !== 'undefined';
    const service = props.match.params.service;
    const serviceOk = service && service !== UNKNOWN && service !== 'undefined';
    const workload = props.match.params.workload;
    const workloadOk = workload && workload !== UNKNOWN && workload !== 'undefined';
    if (!appOk && !namespaceOk && !serviceOk && !workloadOk) {
      // @ts-ignore
      return;
    }

    let nodeType;
    let version;
    if (appOk || workloadOk) {
      nodeType = appOk ? NodeType.APP : NodeType.WORKLOAD;
      version = props.match.params.version;
    } else {
      nodeType = NodeType.SERVICE;
      version = '';
    }
    return {
      app: app!,
      namespace: { name: namespace! },
      nodeType: nodeType,
      service: service!,
      version: version,
      workload: workload!
    };
  }

  static isNodeChanged(prevNode?: NodeParamsType, node?: NodeParamsType): boolean {
    if (prevNode === node) {
      return false;
    }
    if ((prevNode && !node) || (!prevNode && node)) {
      return true;
    }
    if (prevNode && node) {
      const nodeAppHasChanged = prevNode.app !== node.app;
      const nodeServiceHasChanged = prevNode.service !== node.service;
      const nodeVersionHasChanged = prevNode.version !== node.version;
      const nodeTypeHasChanged = prevNode.nodeType !== node.nodeType;
      const nodeWorkloadHasChanged = prevNode.workload !== node.workload;
      return (
        nodeAppHasChanged ||
        nodeServiceHasChanged ||
        nodeVersionHasChanged ||
        nodeWorkloadHasChanged ||
        nodeTypeHasChanged
      );
    }
    return false;
  }

  constructor(props: GraphPageProps) {
    super(props);
    this.errorBoundaryRef = React.createRef();
    this.cytoscapeGraphRef = React.createRef();
    this.focusSelector = getFocusSelector();
    // Let URL override current redux state at construction time
    // Note that state updates will not be posted until after the first render
    const urlNode = GraphPage.getNodeParamsFromProps(props);
    if (GraphPage.isNodeChanged(urlNode, props.node)) {
      props.setNode(urlNode);
    }

    this.graphDataSource = new GraphDataSource();
  }

  componentDidMount() {
    // This is a special bookmarking case. If the initial URL is for a node graph then
    // defer the graph fetch until the first component update, when the node is set.
    // (note: to avoid direct store access we could parse the URL again, perhaps that
    // is preferable?  We could also move the logic from the constructor, but that
    // would break our pattern of redux/url handling in the components).
    if (!store.getState().graph.node) {
      this.loadGraphDataFromBackend();
    }

    // Connect to graph data source updates
    this.graphDataSource.on('loadStart', this.handleGraphDataSourceUpdate);
    this.graphDataSource.on('fetchError', this.handleGraphDataSourceUpdate);
    this.graphDataSource.on('fetchSuccess', this.handleGraphDataSourceUpdate);
    this.graphDataSource.on('emptyNamespaces', this.handleGraphDataSourceUpdate);
  }

  componentDidUpdate(prev: GraphPageProps) {
    // schedule an immediate graph fetch if needed
    const curr = this.props;

    const activeNamespacesChanged = !arrayEquals(
      prev.activeNamespaces,
      curr.activeNamespaces,
      (n1, n2) => n1.name === n2.name
    );

    // Ensure we initialize the graph when there is a change to activeNamespaces.
    if (activeNamespacesChanged) {
      this.props.graphChanged();
    }

    if (
      activeNamespacesChanged ||
      prev.duration !== curr.duration ||
      (prev.edgeLabelMode !== curr.edgeLabelMode &&
        curr.edgeLabelMode === EdgeLabelMode.RESPONSE_TIME_95TH_PERCENTILE) ||
      prev.graphType !== curr.graphType ||
      (prev.lastRefreshAt !== curr.lastRefreshAt && curr.replayQueryTime === 0) ||
      prev.replayQueryTime !== curr.replayQueryTime ||
      prev.showServiceNodes !== curr.showServiceNodes ||
      prev.showSecurity !== curr.showSecurity ||
      prev.showUnusedNodes !== curr.showUnusedNodes ||
      GraphPage.isNodeChanged(prev.node, curr.node)
    ) {
      this.loadGraphDataFromBackend();
    }

    if (!!this.focusSelector) {
      this.focusSelector = undefined;
      unsetFocusSelector();
    }

    if (prev.layout.name !== curr.layout.name || activeNamespacesChanged) {
      this.errorBoundaryRef.current.cleanError();
    }

    if (curr.showLegend && this.props.activeTour) {
      this.props.endTour();
    }
  }

  componentWillUnmount() {
    // Disconnect from graph data source updates
    this.graphDataSource.removeListener('loadStart', this.handleGraphDataSourceUpdate);
    this.graphDataSource.removeListener('fetchError', this.handleGraphDataSourceUpdate);
    this.graphDataSource.removeListener('fetchSuccess', this.handleGraphDataSourceUpdate);
    this.graphDataSource.removeListener('emptyNamespaces', this.handleGraphDataSourceUpdate);
  }

  render() {
    let conStyle = containerStyle;
    if (isKioskMode()) {
      conStyle = kioskContainerStyle;
    }
    const isReady =
      this.graphDataSource.graphData.nodes &&
      Object.keys(this.graphDataSource.graphData.nodes).length > 0 &&
      !this.graphDataSource.isError;
    const isReplayReady = this.props.replayActive && !!this.props.replayQueryTime;
    return (
      <>
        <FlexView className={conStyle} column={true}>
          <div>
            <GraphToolbarContainer disabled={this.graphDataSource.isLoading} onToggleHelp={this.toggleHelp} />
          </div>
          <FlexView
            grow={true}
            className={`${cytoscapeGraphWrapperDivStyle} ${this.props.replayActive && replayBorder}`}
          >
            <ErrorBoundary
              ref={this.errorBoundaryRef}
              onError={this.notifyError}
              fallBackComponent={<GraphErrorBoundaryFallback />}
            >
              {this.props.showLegend && (
                <GraphLegend
                  className={graphLegendStyle}
                  isMTLSEnabled={this.props.mtlsEnabled}
                  closeLegend={this.props.toggleLegend}
                />
              )}
              {isReady && (
                <Chip
                  className={`${graphTimeRangeDivStyle} ${
                    this.props.replayActive ? replayBackground : whiteBackground
                  }`}
                  isOverflowChip={true}
                  isReadOnly={true}
                >
                  {this.props.replayActive && <Badge style={{ marginRight: '4px' }} isRead={true}>{`Replay`}</Badge>}
                  {!isReplayReady && this.props.replayActive && `click Play to start`}
                  {!isReplayReady && !this.props.replayActive && `${this.displayTimeRange()}`}
                  {isReplayReady && `${this.displayTimeRange()}`}
                </Chip>
              )}
              {(!this.props.replayActive || isReplayReady) && (
                <TourStopContainer info={GraphTourStops.Graph}>
                  <TourStopContainer info={GraphTourStops.ContextualMenu}>
                    <CytoscapeGraphContainer
                      onEmptyGraphAction={this.handleEmptyGraphAction}
                      containerClassName={cytoscapeGraphContainerStyle}
                      ref={refInstance => this.setCytoscapeGraph(refInstance)}
                      isMTLSEnabled={this.props.mtlsEnabled}
                      focusSelector={this.focusSelector}
                      contextMenuNodeComponent={NodeContextMenuContainer}
                      contextMenuGroupComponent={NodeContextMenuContainer}
                      dataSource={this.graphDataSource}
                    />
                  </TourStopContainer>
                </TourStopContainer>
              )}
              {isReady && (
                <div className={cytoscapeToolbarWrapperDivStyle}>
                  <CytoscapeToolbarContainer cytoscapeGraphRef={this.cytoscapeGraphRef} />
                </div>
              )}
            </ErrorBoundary>
            {this.props.summaryData && (
              <SummaryPanel
                data={this.props.summaryData}
                namespaces={this.props.activeNamespaces}
                graphType={this.props.graphType}
                injectServiceNodes={this.props.showServiceNodes}
                queryTime={this.graphDataSource.graphTimestamp}
                duration={this.graphDataSource.graphDuration}
                isPageVisible={this.props.isPageVisible}
                {...computePrometheusRateParams(this.props.duration, NUMBER_OF_DATAPOINTS)}
              />
            )}
          </FlexView>
        </FlexView>
      </>
    );
  }

  private handleEmptyGraphAction = () => {
    this.loadGraphDataFromBackend();
  };

  private handleGraphDataSourceUpdate = () => {
    this.forceUpdate();
  };

  private toggleHelp = () => {
    if (this.props.showLegend) {
      this.props.toggleLegend();
    }
    if (this.props.activeTour) {
      this.props.endTour();
    } else {
      const firstStop = getNextTourStop(GraphTour, -1, 'forward');
      this.props.startTour({ info: GraphTour, stop: firstStop });
    }
  };

  private setCytoscapeGraph(cytoscapeGraph: any) {
    this.cytoscapeGraphRef.current = cytoscapeGraph;
  }

  private loadGraphDataFromBackend = () => {
    const queryTime: TimeInMilliseconds | undefined = !!this.props.replayQueryTime
      ? this.props.replayQueryTime
      : undefined;

    this.graphDataSource.fetchGraphData({
      namespaces: this.props.node ? [this.props.node.namespace] : this.props.activeNamespaces,
      duration: this.props.duration,
      graphType: this.props.graphType,
      injectServiceNodes: this.props.showServiceNodes,
      edgeLabelMode: this.props.edgeLabelMode,
      showSecurity: this.props.showSecurity,
      showUnusedNodes: this.props.showUnusedNodes,
      node: this.props.node,
      queryTime: queryTime
    });
  };

  private notifyError = (error: Error, _componentStack: string) => {
    AlertUtils.add(`There was an error when rendering the graph: ${error.message}, please try a different layout`);
  };

  private displayTimeRange = () => {
    const rangeEnd: TimeInMilliseconds = this.graphDataSource.graphTimestamp * 1000;
    const rangeStart: TimeInMilliseconds = rangeEnd - this.props.duration * 1000;

    return toRangeString(rangeStart, rangeEnd, { second: '2-digit' }, { second: '2-digit' });
  };
}

const mapStateToProps = (state: KialiAppState) => ({
  activeNamespaces: activeNamespacesSelector(state),
  activeTour: state.tourState.activeTour,
  duration: durationSelector(state),
  edgeLabelMode: edgeLabelModeSelector(state),
  graphType: graphTypeSelector(state),
  isPageVisible: state.globalState.isPageVisible,
  lastRefreshAt: lastRefreshAtSelector(state),
  layout: state.graph.layout,
  node: state.graph.node,
  replayActive: replayActiveSelector(state),
  replayQueryTime: replayQueryTimeSelector(state),
  showLegend: state.graph.toolbarState.showLegend,
  showSecurity: state.graph.toolbarState.showSecurity,
  showServiceNodes: state.graph.toolbarState.showServiceNodes,
  showUnusedNodes: state.graph.toolbarState.showUnusedNodes,
  summaryData: state.graph.summaryData,
  mtlsEnabled: meshWideMTLSEnabledSelector(state)
});

const mapDispatchToProps = (dispatch: ThunkDispatch<KialiAppState, void, KialiAppAction>) => ({
  graphChanged: bindActionCreators(GraphActions.changed, dispatch),
  setNode: bindActionCreators(GraphActions.setNode, dispatch),
  toggleLegend: bindActionCreators(GraphToolbarActions.toggleLegend, dispatch),
  endTour: bindActionCreators(TourActions.endTour, dispatch),
  startTour: bindActionCreators(TourActions.startTour, dispatch)
});

const GraphPageContainer = connect(
  mapStateToProps,
  mapDispatchToProps
)(GraphPage);
export default GraphPageContainer;
