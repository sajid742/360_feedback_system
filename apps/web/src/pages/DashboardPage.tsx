import { Building2, Settings, Target } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth, usePermissions } from '@/features/auth/AuthContext';
import { ExecutiveDashboard } from '@/features/reports/ExecutiveDashboard';
import { HrDashboard } from '@/features/reports/HrDashboard';

/** Landing page: the executive + HR dashboards for those permitted, otherwise a
 *  simple welcome with quick links (role-based — driven by reports.executive). */
export function DashboardPage(): JSX.Element {
  const { user } = useAuth();
  const { has } = usePermissions();

  if (has('reports.executive')) {
    return (
      <Tabs defaultValue="executive" className="grid gap-4">
        <TabsList>
          <TabsTrigger value="executive">Executive Dashboard</TabsTrigger>
          <TabsTrigger value="hr">HR Dashboard</TabsTrigger>
        </TabsList>
        <TabsContent value="executive">
          <ExecutiveDashboard />
        </TabsContent>
        <TabsContent value="hr">
          <HrDashboard />
        </TabsContent>
      </Tabs>
    );
  }

  const tiles = [
    { to: '/organization', label: 'Organization', icon: <Building2 className="size-5" />, desc: 'People, departments, org chart' },
    { to: '/competency', label: 'Competencies', icon: <Target className="size-5" />, desc: 'Library, categories, indicators' },
    { to: '/settings', label: 'Settings', icon: <Settings className="size-5" />, desc: 'Flags, rating scales, config' },
  ];
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Welcome{user?.fullName ? `, ${user.fullName}` : ''}</h1>
        <p className="text-sm text-muted-foreground">Jump into a module to get started.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((tile) => (
          <Link key={tile.to} to={tile.to}>
            <Card className="flex items-start gap-3 p-5 transition-shadow hover:shadow-card-hover">
              <span className="flex size-10 items-center justify-center rounded-lg bg-indigo-50 text-brand">
                {tile.icon}
              </span>
              <div>
                <p className="font-bold">{tile.label}</p>
                <p className="text-sm text-muted-foreground">{tile.desc}</p>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
