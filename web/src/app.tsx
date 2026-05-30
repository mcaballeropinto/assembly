import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <Card className="max-w-md mx-auto">
        <CardHeader>
          <CardTitle>Assembly Dashboard</CardTitle>
          <CardDescription>shadcn/ui smoke check</CardDescription>
        </CardHeader>
        <CardContent>
          <Button>It works</Button>
        </CardContent>
      </Card>
    </div>
  )
}
