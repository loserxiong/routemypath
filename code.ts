// This plugin will open a window to prompt the user to enter a number, and
// it will then create that many rectangles on the screen.

// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).

// This shows the HTML page in "ui.html".
figma.showUI(__html__, { width: 280, height: 320 });

// 定义 Point 接口
interface Point {
  lat: number;
  lon: number;
  time: Date | null;
  distance: number;
}

// 定义 GPX 数据结构
interface GPXPoint {
  lat: number;
  lon: number;
  ele?: number;
  time?: string;
}

interface GPXData {
  points: GPXPoint[];
  distance: number;
  duration: number;
  pace: number;
}

// 定义路径命令类型
interface VectorPathCommand {
  type: 'M' | 'L';
  x: number;
  y: number;
}

// 解析 GPX 文件内容
function parseGPX(content: string): GPXData {
  try {
    console.log('开始解析 GPX 文件...');
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(content, "text/xml");
    
    // 检查 XML 解析错误
    const parserError = xmlDoc.querySelector('parsererror');
    if (parserError) {
      throw new Error('XML 解析错误: ' + parserError.textContent);
    }

    const trkpts = xmlDoc.getElementsByTagName("trkpt");
    console.log(`找到 ${trkpts.length} 个轨迹点`);
    
    if (trkpts.length === 0) {
      throw new Error('未找到轨迹点数据');
    }

    const points: GPXPoint[] = [];
    let totalDistance = 0;
    let startTime: Date | null = null;
    let endTime: Date | null = null;

    // 解析所有轨迹点
    for (let i = 0; i < trkpts.length; i++) {
      const pt = trkpts[i];
      const lat = parseFloat(pt.getAttribute("lat") || "0");
      const lon = parseFloat(pt.getAttribute("lon") || "0");
      
      if (isNaN(lat) || isNaN(lon)) {
        console.warn(`跳过无效的坐标点 ${i}: lat=${lat}, lon=${lon}`);
        continue;
      }

      const ele = pt.getElementsByTagName("ele")[0]?.textContent || undefined;
      const time = pt.getElementsByTagName("time")[0]?.textContent || undefined;

      points.push({
        lat,
        lon,
        ele: ele ? parseFloat(ele) : undefined,
        time
      });

      // 计算时间
      if (time) {
        try {
          const currentTime = new Date(time);
          if (!startTime) startTime = currentTime;
          endTime = currentTime;
        } catch (e) {
          console.warn(`无法解析时间戳: ${time}`);
        }
      }

      // 计算距离
      if (i > 0) {
        const prevPt = points[i - 1];
        const prev: Point = {
          lat: prevPt.lat,
          lon: prevPt.lon,
          time: prevPt.time ? new Date(prevPt.time) : null,
          distance: 0
        };
        totalDistance += calculateDistance(prev, {
          lat,
          lon,
          time: time ? new Date(time) : null,
          distance: 0
        });
      }
    }

    if (points.length === 0) {
      throw new Error('没有有效的轨迹点数据');
    }

    // 计算总时长（秒）
    const duration = startTime && endTime ? 
      (endTime.getTime() - startTime.getTime()) / 1000 : 0;

    // 计算配速（分钟/公里）
    const pace = totalDistance > 0 ? (duration / 60) / (totalDistance / 1000) : 0;

    console.log('GPX 解析完成:', {
      pointsCount: points.length,
      totalDistance: totalDistance,
      duration: duration,
      pace: pace
    });

    return {
      points,
      distance: totalDistance,
      duration,
      pace
    };
  } catch (error) {
    console.error('GPX 解析错误:', error);
    throw error;
  }
}

// 定义 VectorPath 接口
interface VectorPath {
  readonly windingRule: 'NONZERO' | 'EVENODD';
  readonly data: string;
}

// 计算两点之间的距离（米）- 优化版 Haversine 公式
function calculateDistance(point1: Point, point2: Point): number {
  const R = 6371008.8; // WGS84 椭球体的平均半径（米），与苹果使用的更接近
  
  // 将度数转换为弧度
  const lat1Rad = point1.lat * Math.PI / 180;
  const lat2Rad = point2.lat * Math.PI / 180;
  const deltaLatRad = (point2.lat - point1.lat) * Math.PI / 180;
  const deltaLonRad = (point2.lon - point1.lon) * Math.PI / 180;

  // Haversine 公式
  const a = Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
            Math.cos(lat1Rad) * Math.cos(lat2Rad) *
            Math.sin(deltaLonRad / 2) * Math.sin(deltaLonRad / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // 距离（米）
  const distance = R * c;
  
  // 过滤掉异常的距离值（比如超过200米的单点距离，可能是GPS漂移）
  if (distance > 200) {
    console.warn(`检测到异常距离: ${distance.toFixed(2)}m，可能是GPS漂移`);
    return 0; // 忽略异常距离
  }
  
  return distance;
}

// 创建路线图
async function createRoute(points: GPXPoint[]) {
  try {
    console.log('开始创建路线图...');
    // 找到经纬度的范围
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    
    points.forEach(point => {
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
      minLon = Math.min(minLon, point.lon);
      maxLon = Math.max(maxLon, point.lon);
    });

    console.log('坐标范围:', { minLat, maxLat, minLon, maxLon });

    // 创建路径
    const path = figma.createVector();
    const commands: VectorPathCommand[] = [];
    
    points.forEach((point, i) => {
      // 将经纬度转换为相对坐标（0-1范围）
      const x = (point.lon - minLon) / (maxLon - minLon);
      const y = 1 - (point.lat - minLat) / (maxLat - minLat);
      
      if (i === 0) {
        commands.push({
          type: 'M',
          x: x * 1000,
          y: y * 1000
        });
      } else {
        commands.push({
          type: 'L',
          x: x * 1000,
          y: y * 1000
        });
      }
    });

    const pathData = commands.map(cmd => `${cmd.type} ${cmd.x} ${cmd.y}`).join(' ');
    console.log('路径数据长度:', pathData.length);

    path.vectorPaths = [{
      windingRule: "NONZERO",
      data: pathData
    }];

    // 设置路径样式
    path.strokes = [{
      type: 'SOLID',
      color: { r: 0, g: 0.5, b: 1 },
      opacity: 1
    }];
    path.strokeWeight = 2;
    path.strokeCap = "ROUND";
    path.strokeJoin = "ROUND";

    figma.currentPage.appendChild(path);
    figma.currentPage.selection = [path];
    figma.viewport.scrollAndZoomIntoView([path]);
    console.log('路线图创建完成');
  } catch (error) {
    console.error('创建路线图时出错:', error);
    throw error;
  }
}

// 创建文本节点
function createTextNode(text: string, fontSize: number = 24): TextNode {
  try {
    const textNode = figma.createText();
    textNode.fontSize = fontSize;
    textNode.characters = text;
    return textNode;
  } catch (error) {
    console.error('创建文本节点时出错:', error);
    throw error;
  }
}

// 存储解析后的 GPX 数据
let gpxData: GPXData | null = null;

// 添加调试日志
console.log('插件已启动');

// Calls to "parent.postMessage" from within the HTML page will trigger this
// callback. The callback will be passed the "pluginMessage" property of the
// posted message.
figma.ui.onmessage = async (msg) => {
  console.log('Received message:', msg.type);
  
  if (msg.type === 'log') {
    console.log('UI log:', msg.message);
    return;
  }
  
  try {
    if (msg.type === 'parse-gpx') {
      console.log('Starting GPX file parsing');
      
      if (!msg.content) {
        throw new Error('File content is empty');
      }

      if (typeof msg.content !== 'string') {
        throw new Error('File content format error');
      }

      if (!msg.content.includes('<gpx') && !msg.content.includes('<GPX')) {
        throw new Error('Not a valid GPX file');
      }

      console.log('File content validation passed, starting parse...');
      
      // Extract track points using regex
      const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)">([\s\S]*?)<\/trkpt>/g;
      const points: Point[] = [];

      console.log('Starting to process track points...');
      
      let match;
      while ((match = trkptRegex.exec(msg.content)) !== null) {
        try {
          const lat = parseFloat(match[1]);
          const lon = parseFloat(match[2]);
          
          if (isNaN(lat) || isNaN(lon)) {
            console.warn(`Skipping invalid coordinate point: lat=${lat}, lon=${lon}`);
            continue;
          }

          const currentPoint: Point = {
            lat,
            lon,
            time: null,
            distance: 0
          };

          points.push(currentPoint);
        } catch (error) {
          console.warn(`Error processing track point:`, error);
        }
      }

      console.log('Track point processing complete, total points:', points.length);

      if (points.length === 0) {
        throw new Error('No valid track points found');
      }

      // Calculate route dimensions for window adjustment
      const lats = points.map(p => p.lat);
      const lons = points.map(p => p.lon);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLon = Math.min(...lons);
      const maxLon = Math.max(...lons);
      
      const latRange = maxLat - minLat;
      const lonRange = maxLon - minLon;
      
      const baseSize = 280;
      let routeWidth, routeHeight;
      
      if (lonRange > latRange) {
        routeWidth = baseSize;
        routeHeight = baseSize * (latRange / lonRange);
      } else {
        routeHeight = baseSize;
        routeWidth = baseSize * (lonRange / latRange);
      }

      // Adjust window size based on route dimensions
      const windowWidth = Math.max(280, Math.min(400, routeWidth + 40)); // min 280, max 400, plus 40px margin
      const windowHeight = Math.max(320, routeHeight + 160); // reserve 160px for buttons and text
      
      figma.ui.resize(Math.round(windowWidth), Math.round(windowHeight));

      // Save data for route use
      figma.clientStorage.setAsync('gpxData', {
        points
      });

      // Send parse complete message to UI
      figma.ui.postMessage({
        type: 'parse-complete',
        points: points,
        routeWidth: routeWidth,
        routeHeight: routeHeight
      });

      console.log('GPX file parsing complete');
    } else if (msg.type === 'show-route') {
      console.log('Received show-route message');
      const data = await figma.clientStorage.getAsync('gpxData');
      console.log('Retrieved data:', data);
      if (!data) {
        throw new Error('No route data available');
      }

      console.log('Starting route data processing...');
      // Normalize lat/lon to canvas area with correct aspect ratio
      const lats = data.points.map((p: Point) => p.lat);
      const lons = data.points.map((p: Point) => p.lon);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLon = Math.min(...lons);
      const maxLon = Math.max(...lons);
      
      // Calculate lat/lon ranges
      const latRange = maxLat - minLat;
      const lonRange = maxLon - minLon;
      
      // Maintain correct aspect ratio with appropriate size
      const baseSize = 400; // Base size
      let width, height;
      
      if (lonRange > latRange) {
        width = baseSize;
        height = baseSize * (latRange / lonRange);
      } else {
        height = baseSize;
        width = baseSize * (lonRange / latRange);
      }

      console.log('Lat/lon range:', { minLat, maxLat, minLon, maxLon });
      console.log('Calculated dimensions:', { width, height });

      const pathData: VectorPath = {
        windingRule: 'NONZERO',
        data: data.points.map((point: Point, index: number) => {
          const x = lonRange === 0 ? width / 2 : ((point.lon - minLon) / lonRange) * width;
          const y = latRange === 0 ? height / 2 : ((maxLat - point.lat) / latRange) * height;
          
          // Ensure coordinates are within correct range
          const normalizedX = Math.max(0, Math.min(width, x));
          const normalizedY = Math.max(0, Math.min(height, y));
          
          return index === 0 ? `M ${normalizedX} ${normalizedY}` : `L ${normalizedX} ${normalizedY}`;
        }).join(' ')
      };

      console.log('Route point count:', data.points.length);
      console.log('Path data first 100 characters:', pathData.data.substring(0, 100));

      const route = figma.createVector();
      route.name = 'Running Route';
      route.vectorPaths = [pathData];
      route.strokes = [{
        type: 'SOLID',
        color: { r: 0.988, g: 0.318, b: 0 },
        opacity: 1
      }];
      route.strokeWeight = 2;
      route.strokeCap = 'ROUND';
      route.strokeJoin = 'ROUND';
      
      // Place route at the center of user's current viewport
      route.x = figma.viewport.center.x - width / 2;
      route.y = figma.viewport.center.y - height / 2;
      
      console.log('Route coordinates:', route.x, route.y);
      console.log('Route dimensions:', route.width, route.height);
      
      figma.currentPage.appendChild(route);
      figma.notify('Route created successfully');
    } else if (msg.type === 'resize-window') {
      figma.ui.resize(msg.width, msg.height);
    }
  } catch (error) {
    console.error('Error during processing:', error);
    figma.notify('Error: ' + (error as Error).message);
    figma.ui.postMessage({ 
      type: 'error',
      message: (error as Error).message
    });
  }
};
